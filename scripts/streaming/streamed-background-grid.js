/**
 * @fileoverview Tiled background mesh grid with low-res fallback for FloorRenderBus.
 * @module streaming/streamed-background-grid
 */

import { createLogger } from '../core/log.js';
import { GROUND_Z } from '../compositor-v2/LayerOrderPolicy.js';
import { intersectRects, rectsIntersect } from './streaming-grid.js';
import {
  buildPyramidManifest,
  loadPyramidTileTexture,
  loadFallbackTexture,
} from './texture-pyramid-builder.js';
import { isHugeImageSource } from './probe-image-dimensions.js';
import { loadImageTexture } from '../assets/image-texture-loader.js';
import { getTextureBudgetTracker, estimateTextureBytes } from '../assets/TextureBudgetTracker.js';
import { getSceneRegionFromFoundryData } from './view-projection-service.js';
import { estimateSceneMegapixels } from './texture-budget-policy.js';

const log = createLogger('StreamedBackgroundGrid');

/** @type {import('./streaming-grid.js').StreamingCellState} */
const STATE_CULLED = 'culled';
/** @type {import('./streaming-grid.js').StreamingCellState} */
const STATE_LOADING = 'loading';
/** @type {import('./streaming-grid.js').StreamingCellState} */
const STATE_RESIDENT_HI = 'resident-hi';
/** @type {import('./streaming-grid.js').StreamingCellState} */
const STATE_RESIDENT_LO = 'resident-lo';
/** @type {import('./streaming-grid.js').StreamingCellState} */
const STATE_FALLBACK = 'fallback-only';

/** @param {number} effectiveLod @param {Iterable<string>} requiredKeys */
function buildViewSyncKey(effectiveLod, requiredKeys) {
  return `${effectiveLod}:${[...requiredKeys].sort().join(',')}`;
}

/**
 * Required cells that still need a resident texture at or below effectiveLod.
 * @param {Array<{ key: string }>} required
 * @param {number} effectiveLod
 * @param {Map<string, { mesh?: import('three').Object3D, lod?: number }>} cells
 * @param {Set<string>} inflight
 * @returns {number}
 */
function countUnmetRequiredCells(required, effectiveLod, cells, inflight) {
  let n = 0;
  for (const cell of required) {
    if (inflight.has(cell.key)) continue;
    const existing = cells.get(cell.key);
    if (!existing?.mesh) {
      n += 1;
    } else if (Number(existing.lod) > effectiveLod) {
      n += 1;
    }
  }
  return n;
}

/** @returns {number} */
function maxTotalResidentCellsForScene() {
  const mp = estimateSceneMegapixels();
  if (mp >= 144) return 18;
  if (mp > 64) return 24;
  return 32;
}

export class StreamedBackgroundGrid {
  /**
   * @param {import('../compositor-v2/FloorRenderBus.js').FloorRenderBus} bus
   * @param {object} options
   */
  constructor(bus, options = {}) {
    this._bus = bus;
    this._scene = bus?.getScene?.() ?? null;
    this._src = '';
    this._key = '';
    this._floorIndex = 0;
    this._fd = null;
    this._manifest = null;
    this._fallbackMesh = null;
    /** @type {import('three').Mesh[]} */
    this._fallbackCellMeshes = [];
    /** @type {Map<string, { mesh: import('three').Object3D, state: string, lod: number }>} */
    this._cells = new Map();
    /** @type {Map<string, import('./streaming-grid.js').StreamingCellState>} */
    this._cellStates = new Map();
    this._cellSize = options.cellSize ?? 2048;
    this._maxLod = options.maxLod ?? 4;
    this._decodeEpoch = 0;
    /** @type {Set<string>} */
    this._inflight = new Set();
    this._maxConcurrent = 4;
    /** @type {{ minX: number, minY: number, maxX: number, maxY: number }|null} */
    this._sceneRegion = null;
    /** Coarsest LOD we have committed to — hysteresis prevents load/evict thrash. */
    this._servedLod = 99;
    this._syncKey = '';
    /** @type {Map<string, number>} */
    this._cellLastUsed = new Map();
  }

  /** @private */
  _getSceneRegion() {
    if (this._sceneRegion) return this._sceneRegion;
    this._sceneRegion = getSceneRegionFromFoundryData(this._fd);
    return this._sceneRegion;
  }

  /** @private */
  _maxResidentCells() {
    const mp = estimateSceneMegapixels();
    // Typical frustum on 12000² @ 0.3 zoom needs ~9 cells (3×3).
    if (mp >= 144) return 9;
    if (mp > 64) return 12;
    return 16;
  }

  /** @private */
  _maxTotalResidentCells() {
    return maxTotalResidentCellsForScene();
  }

  /** @private */
  _countVisibleResidents() {
    let n = 0;
    for (const entry of this._cells.values()) {
      if (entry?.mesh?.visible) n += 1;
    }
    return n;
  }

  /** @private */
  _effectiveLod(lod) {
    const budget = getTextureBudgetTracker();
    let effective = Math.max(0, Math.floor(Number(lod) || 0));
    const used = budget.getUsedFraction();
    if (used > 0.98) {
      effective = Math.min(this._maxLod, effective + 1);
    }
    return Math.min(effective, this._maxLod);
  }

  /**
   * Per-cell LOD target — center of view keeps full resolution under VRAM pressure.
   * @param {{ cellX: number, cellY: number }} cell
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} viewRect
   * @param {number} lod
   * @returns {number}
   * @private
   */
  _effectiveLodForCell(cell, viewRect, lod) {
    const base = this._effectiveLod(lod);
    const budget = getTextureBudgetTracker();
    const used = budget.getUsedFraction();
    if (used <= 0.92 || !viewRect || !this._manifest) return base;

    const region = this._getSceneRegion();
    if (!region) return base;

    const bounds = imageCellToWorldBounds(
      cell.cellX,
      cell.cellY,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
      region,
    );
    const bcx = (bounds.minX + bounds.maxX) * 0.5;
    const bcy = (bounds.minY + bounds.maxY) * 0.5;
    const vcx = (viewRect.minX + viewRect.maxX) * 0.5;
    const vcy = (viewRect.minY + viewRect.maxY) * 0.5;
    const vw = Math.max(1, viewRect.maxX - viewRect.minX);
    const vh = Math.max(1, viewRect.maxY - viewRect.minY);
    const dist = Math.max(Math.abs(bcx - vcx) / (vw * 0.5), Math.abs(bcy - vcy) / (vh * 0.5));

    if (dist <= 0.5) return base;
    if (used > 1.0) return Math.min(this._maxLod, base + (dist <= 1.05 ? 1 : 2));
    if (used > 0.95) return Math.min(this._maxLod, base + 1);
    return base;
  }

  /** @private */
  _vramLodSlack() {
    return getTextureBudgetTracker().getUsedFraction() > 0.92 ? 1 : 0;
  }

  /**
   * True when a resident cell texture is sharp enough — avoids reload on pan-only
   * sync when VRAM pressure previously forced a coarser pyramid level.
   * @param {number} existingLod
   * @param {{ cellX: number, cellY: number }} cell
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }|null} viewRect
   * @param {number} requestedLod
   * @returns {boolean}
   * @private
   */
  _residentLodAcceptable(existingLod, cell, viewRect, requestedLod, panStabilize = false) {
    const el = Number(existingLod) || 0;
    const zoomLod = this._effectiveLod(requestedLod);
    const cellTarget = viewRect
      ? this._effectiveLodForCell(cell, viewRect, requestedLod)
      : zoomLod;
    if (el <= cellTarget) return true;
    if (panStabilize) return el <= zoomLod + this._vramLodSlack();
    return false;
  }

  /**
   * True when a required cell still needs visibility, residency, or a sharper LOD.
   * @param {{ key: string, cellX: number, cellY: number }} cell
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} viewRect
   * @param {number} requestedLod
   * @param {{ panStabilize?: boolean }} [options]
   * @returns {boolean}
   * @private
   */
  _cellNeedsWork(cell, viewRect, requestedLod, options = {}) {
    const panStabilize = options.panStabilize === true;
    if (this._inflight.has(cell.key)) return false;
    const existing = this._cells.get(cell.key);
    if (!existing?.mesh) return true;
    if (!existing.mesh.visible) return true;
    return !this._residentLodAcceptable(
      existing.lod,
      cell,
      viewRect,
      requestedLod,
      panStabilize,
    );
  }

  /**
   * Hysteresis for coarsening under VRAM pressure only — sharpening is immediate.
   * @param {number} requestedLod
   * @returns {number}
   * @private
   */
  _stabilizeLod(requestedLod) {
    const budget = getTextureBudgetTracker();
    const req = Math.max(0, Math.floor(Number(requestedLod) || 0));
    if (this._servedLod === 99 || req < this._servedLod) {
      this._servedLod = req;
    } else if (req > this._servedLod && budget.getUsedFraction() > 0.98) {
      this._servedLod = req;
    }
    return Math.min(this._servedLod, this._maxLod);
  }

  /**
   * Zoom LOD changed — allow sharpen pass even when the view tile set is unchanged.
   * @param {number} lod
   */
  notifyZoomLod(lod) {
    const req = Math.max(0, Math.floor(Number(lod) || 0));
    if (req < this._servedLod || this._servedLod === 99) {
      this._servedLod = req;
    }
    this._syncKey = '';
  }

  /**
   * True while visible cells still need loads, upgrades, or async decode is in flight.
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} viewRect
   * @param {number} lod
   * @returns {boolean}
   */
  hasPendingCellWork(viewRect, lod) {
    const region = this._getSceneRegion();
    if (!this._manifest || !viewRect || !region) return false;
    const required = getImageCellsForWorldView(
      viewRect,
      region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
    );
    if (this._inflight.size > 0) return true;
    return required.some((cell) =>
      this._cellNeedsWork(cell, viewRect, lod, { panStabilize: false }),
    );
  }

  /**
   * Start or continue pyramid loads for cells in the current view.
   * @private
   */
  _scheduleRequiredCellLoads(required, effectiveLod, epoch, viewRect = null, requestedLod = effectiveLod, panStabilize = true) {
    const budget = getTextureBudgetTracker();
    const sorted = [...required].sort((a, b) => {
      const la = this._effectiveLodForCell(a, viewRect, requestedLod);
      const lb = this._effectiveLodForCell(b, viewRect, requestedLod);
      const needA = !this._residentLodAcceptable(
        this._cells.get(a.key)?.lod ?? 99,
        a,
        viewRect,
        requestedLod,
        panStabilize,
      );
      const needB = !this._residentLodAcceptable(
        this._cells.get(b.key)?.lod ?? 99,
        b,
        viewRect,
        requestedLod,
        panStabilize,
      );
      if (needA !== needB) return needA ? -1 : 1;
      if (!viewRect) return 0;
      const region = this._getSceneRegion();
      if (!region || !this._manifest) return 0;
      const ba = imageCellToWorldBounds(a.cellX, a.cellY, this._cellSize, this._manifest.sourceWidth, this._manifest.sourceHeight, region);
      const bb = imageCellToWorldBounds(b.cellX, b.cellY, this._cellSize, this._manifest.sourceWidth, this._manifest.sourceHeight, region);
      const vcx = (viewRect.minX + viewRect.maxX) * 0.5;
      const vcy = (viewRect.minY + viewRect.maxY) * 0.5;
      const da = (ba.minX + ba.maxX) * 0.5 - vcx;
      const db = (bb.minX + bb.maxX) * 0.5 - vcx;
      const dya = (ba.minY + ba.maxY) * 0.5 - vcy;
      const dyb = (bb.minY + bb.maxY) * 0.5 - vcy;
      return (da * da + dya * dya) - (db * db + dyb * dyb);
    });

    for (const cell of sorted) {
      const cellLod = viewRect
        ? this._effectiveLodForCell(cell, viewRect, requestedLod)
        : effectiveLod;
      this._cellLastUsed.set(cell.key, performance.now());
      const existing = this._cells.get(cell.key);
      if (existing?.mesh) {
        if (this._residentLodAcceptable(existing.lod, cell, viewRect, requestedLod, panStabilize)) {
          existing.mesh.visible = this._isFloorVisible();
          this._setCellState(cell.key, existing.lod === 0 ? STATE_RESIDENT_HI : STATE_RESIDENT_LO);
          continue;
        }
        existing.mesh.visible = this._isFloorVisible();
        if (this._inflight.has(cell.key)) continue;
        if (this._inflight.size >= this._maxConcurrent) continue;
        this._setCellState(cell.key, STATE_LOADING);
        this._inflight.add(cell.key);
        void this._loadCell(cell.cellX, cell.cellY, cellLod, epoch);
        continue;
      }
      if (this._inflight.has(cell.key)) continue;
      if (this._inflight.size >= this._maxConcurrent) continue;
      if (this._cells.size >= this._maxTotalResidentCells()) {
        this.evictCells(budget, 1);
      }
      if (!this._cells.has(cell.key) && this._countVisibleResidents() >= this._maxResidentCells()) {
        this.evictCells(budget, 1);
      }

      this._setCellState(cell.key, STATE_LOADING);
      this._inflight.add(cell.key);
      void this._loadCell(cell.cellX, cell.cellY, cellLod, epoch);
    }
  }

  /** @private */
  _cellBusKey(cellKey) {
    return `${this._key}:cell:${cellKey}`;
  }

  /**
   * Evict culled (or highest-LOD) resident cells when VRAM is tight.
   * @param {import('../assets/TextureBudgetTracker.js').TextureBudgetTracker} [_tracker]
   * @param {number} [maxEvict=8]
   * @returns {number}
   */
  evictCells(_tracker, maxEvict = 8) {
    if (!this._cells.size) return 0;
    /** @type {Array<{ key: string, entry: { mesh: import('three').Object3D, state: string, lod: number }, visible: boolean, lod: number }>} */
    const candidates = [];
    for (const [key, entry] of this._cells) {
      candidates.push({
        key,
        entry,
        visible: !!entry?.mesh?.visible,
        lod: Number(entry?.lod) || 0,
      });
    }
    // Never evict visible cells — evicting the frustum causes blue/green minimap thrash.
    candidates.sort((a, b) => {
      if (a.visible !== b.visible) return a.visible ? 1 : -1;
      const ageA = this._cellLastUsed.get(a.key) ?? 0;
      const ageB = this._cellLastUsed.get(b.key) ?? 0;
      if (ageA !== ageB) return ageA - ageB;
      return b.lod - a.lod;
    });
    let evicted = 0;
    for (const { key, entry, visible } of candidates) {
      if (evicted >= maxEvict) break;
      if (visible) continue;
      this._disposeCell(key, entry);
      evicted += 1;
    }
    return evicted;
  }

  /** @private */
  _disposeCell(key, entry) {
    try {
      const tex = entry?.mesh?.material?.map;
      this._bus._unregisterStreamingMesh?.(this._cellBusKey(key));
      entry.mesh?.removeFromParent?.();
      entry.mesh?.geometry?.dispose?.();
      entry.mesh?.material?.dispose?.();
      getTextureBudgetTracker().unregister(tex);
    } catch (_) {}
    this._cellLastUsed.delete(key);
    this._cells.delete(key);
    this._setCellState(key, STATE_CULLED);
  }

  /**
   * Build a coarse tiled fallback from pyramid cells (avoids full-image decode on 12k sources).
   * @param {number} [lod=3]
   * @returns {Promise<boolean>}
   * @private
   */
  async _mountCoarseGridFallback(lod = 3) {
    const region = this._getSceneRegion();
    if (!region || !this._manifest || !this._scene) return false;
    const epoch = this._decodeEpoch;

    /** @type {import('three').Mesh[]} */
    const meshes = [];
    const { cols, rows } = this._manifest;

    for (let cellY = 0; cellY < rows; cellY += 1) {
      for (let cellX = 0; cellX < cols; cellX += 1) {
        if (epoch !== this._decodeEpoch) return false;
        const tex = await loadPyramidTileTexture(
          this._src,
          cellX,
          cellY,
          lod,
          this._cellSize,
          this._manifest.sourceWidth,
          this._manifest.sourceHeight,
        );
        if (!tex) continue;

        const bounds = imageCellToWorldBounds(
          cellX,
          cellY,
          this._cellSize,
          this._manifest.sourceWidth,
          this._manifest.sourceHeight,
          region,
        );
        const mesh = this._createCellMesh(cellX, cellY, bounds, tex, lod);
        mesh.userData.mapShineStreamingFallback = true;
        mesh.userData.streamCellX = cellX;
        mesh.userData.streamCellY = cellY;
        mesh.renderOrder = 0;
        getTextureBudgetTracker().register(
          tex,
          `stream:fallback-cell:${this._key}:${cellX},${cellY}:L${lod}`,
          estimateTextureBytes(tex.image?.width ?? 128, tex.image?.height ?? 128, 'ubyte'),
          { source: 'streamFallback' },
        );
        meshes.push(mesh);
      }
    }

    this._fallbackCellMeshes = meshes;
    return meshes.length > 0;
  }

  /**
   * Per-cell fallback: coarse tiles stay visible until each stream cell is textured.
   * @param {Array<{ key: string }>} required
   * @private
   */
  _syncFallbackVisibility(required) {
    const floorVis = this._isFloorVisible();
    const requiredKeys = new Set(required.map((c) => c.key));

    if (this._fallbackCellMeshes.length) {
      for (const mesh of this._fallbackCellMeshes) {
        const cx = mesh.userData?.streamCellX;
        const cy = mesh.userData?.streamCellY;
        const key = Number.isFinite(cx) && Number.isFinite(cy) ? `${cx},${cy}` : null;
        const inView = key ? requiredKeys.has(key) : false;
        const streamEntry = key ? this._cells.get(key) : null;
        const covered = this._hasTexturedVisibleCell(streamEntry);
        mesh.visible = floorVis && inView && !covered;
      }
      return;
    }

    if (this._fallbackMesh) {
      const allCovered = required.length > 0 && required.every((cell) => {
        const entry = this._cells.get(cell.key);
        return this._hasTexturedVisibleCell(entry);
      });
      this._fallbackMesh.visible = floorVis && !allCovered;
    }
  }

  /** @private */
  _isFloorVisible() {
    const maxFloor = Number.isFinite(Number(this._bus?._visibleMaxFloorIndex))
      ? Number(this._bus._visibleMaxFloorIndex)
      : Infinity;
    return this._floorIndex <= maxFloor && !this._bus?._suppressTileAlbedoForEditing;
  }

  /** @private */
  _releaseFallbackCellMeshes() {
    for (const mesh of this._fallbackCellMeshes) {
      try {
        const tex = mesh.material?.map;
        const fbKey = mesh.userData?.tileId;
        if (fbKey) this._bus._unregisterStreamingMesh?.(fbKey);
        getTextureBudgetTracker().unregister(tex);
        mesh.removeFromParent();
        mesh.geometry?.dispose?.();
        mesh.material?.dispose?.();
      } catch (_) {}
    }
    this._fallbackCellMeshes = [];
  }

  /** @private */
  _maybeReleaseFallback() {
    // Coarse per-cell fallbacks are toggled per stream cell — never bulk-disposed on partial cover.
  }

  /** @private */
  _applyRequiredCellVisibility(required) {
    const floorVis = this._isFloorVisible();
    const now = performance.now();
    for (const cell of required) {
      this._cellLastUsed.set(cell.key, now);
      const existing = this._cells.get(cell.key);
      if (existing?.mesh) {
        existing.mesh.visible = floorVis;
        if (floorVis) {
          const lod = Number(existing.lod) || 0;
          this._setCellState(cell.key, lod === 0 ? STATE_RESIDENT_HI : STATE_RESIDENT_LO);
        }
      }
    }
  }

  /**
   * @returns {Map<string, import('./streaming-grid.js').StreamingCellState>}
   */
  getCellStates() {
    return this._cellStates;
  }

  /**
   * @param {string} src
   * @param {object} fd
   * @param {number} floorIndex
   * @param {string} key
   */
  async mount(src, fd, floorIndex, key) {
    this.dispose();
    this._src = src;
    this._key = key;
    this._floorIndex = floorIndex;
    this._fd = fd;
    this._sceneRegion = null;
    this._decodeEpoch += 1;

    const budget = getTextureBudgetTracker();
    this._cellSize = budget.getRecommendedTileSize();
    this._maxLod = budget.getMaxLodLevel();
    const mp = estimateSceneMegapixels();
    this._maxConcurrent = mp >= 144 ? 2 : mp > 64 ? 3 : 4;

    this._manifest = await buildPyramidManifest(src, this._cellSize, this._maxLod);
    if (!this._manifest) {
      log.warn('StreamedBackgroundGrid: manifest failed', src);
      return;
    }

    const fallbackMax = Math.min(2048, budget.backgroundMaxSize ?? 2048);
    const useCoarseFallback = isHugeImageSource(
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
      fallbackMax * 2,
    );

    if (useCoarseFallback) {
      const fallbackLod = mp > 144 ? 4 : 3;
      void this._mountCoarseGridFallback(fallbackLod);
    } else {
      let fallbackTex = await loadFallbackTexture(src, fallbackMax);
      if (!fallbackTex) {
        try {
          fallbackTex = await loadImageTexture(src, {
            role: 'ALBEDO',
            maxSize: fallbackMax,
            premultiplyAlpha: 'none',
          });
        } catch (err) {
          log.warn('StreamedBackgroundGrid: fallback load failed', src, err);
        }
      }
      if (fallbackTex && this._scene) {
        this._fallbackMesh = this._createBackgroundMesh(
          fd,
          fallbackTex,
          floorIndex,
          `${key}__fallback`,
          true,
        );
        getTextureBudgetTracker().register(
          fallbackTex,
          `stream:fallback:${key}`,
          estimateTextureBytes(fallbackTex.image?.width ?? 512, fallbackTex.image?.height ?? 512, 'ubyte'),
          { source: 'streamFallback' },
        );
      }
    }
  }

  /**
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} viewRect
   * @param {number} lod
   * @param {{ sharpenOnZoom?: boolean }} [options]
   */
  async syncToView(viewRect, lod, options = {}) {
    const region = this._getSceneRegion();
    if (!this._manifest || !viewRect || !region) return;
    const epoch = this._decodeEpoch;
    const effectiveLod = this._stabilizeLod(this._effectiveLod(lod));
    const panStabilize = !options.sharpenOnZoom;
    const required = getImageCellsForWorldView(
      viewRect,
      region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
    );
    const requiredKeys = new Set(required.map((c) => c.key));
    const syncKey = buildViewSyncKey(effectiveLod, requiredKeys);
    const needsSharpen = options.sharpenOnZoom && required.some((cell) => {
      const existing = this._cells.get(cell.key);
      if (!existing?.mesh) return false;
      return !this._residentLodAcceptable(existing.lod, cell, viewRect, lod, false);
    });
    const needsLoad = required.some((cell) =>
      this._cellNeedsWork(cell, viewRect, lod, { panStabilize }),
    );
    const budget = getTextureBudgetTracker();
    if (budget.getUsedFraction() > 1.0 && (needsSharpen || needsLoad)) {
      this.evictCells(budget, 4);
    }
    if (syncKey === this._syncKey && !needsSharpen && !needsLoad) {
      this._applyRequiredCellVisibility(required);
      this._maybeReleaseFallback();
      this._syncFallbackVisibility(required);
      return;
    }
    this._syncKey = syncKey;

    for (const [key, entry] of this._cells) {
      if (!requiredKeys.has(key)) {
        this._setCellState(key, STATE_CULLED);
        if (entry?.mesh) entry.mesh.visible = false;
      }
    }

    this._scheduleRequiredCellLoads(required, effectiveLod, epoch, viewRect, lod, panStabilize);

    this._syncFallbackVisibility(required);
    this._maybeReleaseFallback();
  }

  /**
   * @private
   */
  _hasTexturedVisibleCell(entry) {
    const img = entry?.mesh?.material?.map?.image;
    return !!entry?.mesh?.visible && !!(img && (img.width > 0 || img.height > 0));
  }

  /**
   * @private
   */
  async _loadCell(cellX, cellY, lod, epoch) {
    const key = `${cellX},${cellY}`;
    const region = this._getSceneRegion();
    try {
      if (epoch !== this._decodeEpoch || !region) return;
      const tex = await loadPyramidTileTexture(
        this._src,
        cellX,
        cellY,
        lod,
        this._cellSize,
        this._manifest.sourceWidth,
        this._manifest.sourceHeight,
      );
      if (epoch !== this._decodeEpoch || !tex) return;

      const old = this._cells.get(key);
      if (old?.mesh) {
        const oldTex = old.mesh.material?.map;
        this._bus._unregisterStreamingMesh?.(this._cellBusKey(key));
        old.mesh.removeFromParent();
        old.mesh.geometry?.dispose?.();
        old.mesh.material?.dispose?.();
        getTextureBudgetTracker().unregister(oldTex);
      }

      const bounds = imageCellToWorldBounds(
        cellX,
        cellY,
        this._cellSize,
        this._manifest.sourceWidth,
        this._manifest.sourceHeight,
        region,
      );
      const mesh = this._createCellMesh(cellX, cellY, bounds, tex, lod);
      this._cells.set(key, { mesh, state: STATE_RESIDENT_HI, lod });
      this._setCellState(key, lod === 0 ? STATE_RESIDENT_HI : STATE_RESIDENT_LO);

      getTextureBudgetTracker().register(
        tex,
        `stream:cell:${this._key}:${key}:L${lod}`,
        estimateTextureBytes(tex.image?.width ?? 256, tex.image?.height ?? 256, 'ubyte'),
        { source: 'streamTile' },
      );
      this._syncFallbackCellVisibility(key);
    } finally {
      this._inflight.delete(key);
    }
  }

  /** @param {string} cellKey @private */
  _syncFallbackCellVisibility(cellKey) {
    if (!this._fallbackCellMeshes.length) return;
    const floorVis = this._isFloorVisible();
    for (const mesh of this._fallbackCellMeshes) {
      const cx = mesh.userData?.streamCellX;
      const cy = mesh.userData?.streamCellY;
      const key = Number.isFinite(cx) && Number.isFinite(cy) ? `${cx},${cy}` : null;
      if (key !== cellKey) continue;
      const covered = this._hasTexturedVisibleCell(this._cells.get(key));
      mesh.visible = floorVis && !covered;
    }
  }

  /**
   * @private
   */
  _setCellState(key, state) {
    this._cellStates.set(key, state);
  }

  /**
   * @private
   */
  _createBackgroundMesh(fd, texture, floorIndex, busKey, isFallback) {
    const THREE = window.THREE;
    if (!THREE || !this._scene) return null;

    const sceneW = fd.sceneWidth ?? 1000;
    const sceneH = fd.sceneHeight ?? 1000;
    const sceneX = fd.sceneX ?? 0;
    const sceneY = fd.sceneY ?? 0;
    const worldH = fd.height ?? sceneH;
    const centerX = sceneX + sceneW / 2;
    const centerY = worldH - (sceneY + sceneH / 2);

    texture.flipY = false;
    texture.needsUpdate = true;

    const geom = new THREE.PlaneGeometry(sceneW, sceneH);
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.scale.set(1, -1, 1);
    const z = GROUND_Z - 1 + floorIndex * 0.01 - (isFallback ? 0.001 : 0);
    mesh.position.set(centerX, centerY, z);
    mesh.renderOrder = 0;
    mesh.userData = { tileId: busKey, mapShineStreaming: true, mapShineStreamingFallback: isFallback };
    this._scene.add(mesh);
    this._bus._registerStreamingMesh?.(busKey, mesh, mat, floorIndex);
    return mesh;
  }

  /**
   * @private
   */
  _createCellMesh(cellX, cellY, bounds, texture, lod) {
    const THREE = window.THREE;
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxY - bounds.minY;
    const centerX = bounds.minX + w / 2;
    const centerY = bounds.minY + h / 2;
    texture.flipY = false;
    texture.needsUpdate = true;
    const geom = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.scale.set(1, -1, 1);
    const z = GROUND_Z - 1 + this._floorIndex * 0.01 + 0.002;
    mesh.position.set(centerX, centerY, z);
    mesh.renderOrder = 1 + lod;
    const busKey = this._cellBusKey(`${cellX},${cellY}`);
    mesh.userData = {
      mapShineStreaming: true,
      mapShineStreamingCell: true,
      lod,
      floorIndex: this._floorIndex,
      tileId: busKey,
    };
    this._scene.add(mesh);
    this._bus._registerStreamingMesh?.(busKey, mesh, mat, this._floorIndex);
    mesh.visible = this._isFloorVisible();
    return mesh;
  }

  /** Drop all resident cells so the next sync reloads from pyramid (cache/schema change). */
  reloadAllCells() {
    for (const [key, entry] of [...this._cells.entries()]) {
      this._disposeCell(key, entry);
    }
    this._decodeEpoch += 1;
    this._servedLod = 99;
    this._syncKey = '';
    this._cellLastUsed.clear();
  }

  /** @returns {boolean} */
  isMounted() {
    return !!this._manifest;
  }

  /**
   * Background source + pyramid manifest for debug UI (minimap overview).
   * @returns {{ sourceUrl: string, manifest: object|null, cellSize: number }|null}
   */
  getStreamInfo() {
    if (!this._manifest) return null;
    return {
      sourceUrl: this._src,
      manifest: this._manifest,
      cellSize: this._cellSize,
    };
  }

  /**
   * Per-frame visibility reconcile — ensures required cells are shown even when
   * syncToView early-outs with a stale sync key.
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} viewRect
   */
  reconcileVisibility(viewRect) {
    const region = this._getSceneRegion();
    if (!this._manifest || !viewRect || !region) return;
    const required = getImageCellsForWorldView(
      viewRect,
      region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
    );
    this._applyRequiredCellVisibility(required);
    this._syncFallbackVisibility(required);
  }

  /**
   * Live minimap snapshot — reads resident GPU cells, not the stale _cellStates log.
   * Only includes in-frustum or visible residents so culled history does not wash out greens.
   *
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }|null} [viewRect]
   * @returns {Array<{ bounds: object, state: string, lod: number, visible: boolean }>}
   */
  getMinimapDisplayCells(viewRect = null) {
    const region = this._getSceneRegion();
    if (!this._manifest || !region) return [];

    /** @type {Set<string>|null} */
    let requiredKeys = null;
    if (viewRect) {
      requiredKeys = new Set(
        getImageCellsForWorldView(
          viewRect,
          region,
          this._cellSize,
          this._manifest.sourceWidth,
          this._manifest.sourceHeight,
        ).map((c) => c.key),
      );
    }

    /** @type {Array<{ bounds: object, state: string, lod: number, visible: boolean }>} */
    const out = [];

    const pushKey = (key, state, lod, visible) => {
      const parts = key.split(',');
      if (parts.length !== 2) return;
      out.push({
        bounds: imageCellToWorldBounds(
          Number(parts[0]),
          Number(parts[1]),
          this._cellSize,
          this._manifest.sourceWidth,
          this._manifest.sourceHeight,
          region,
        ),
        state,
        lod,
        visible,
      });
    };

    for (const [key, entry] of this._cells) {
      if (!entry?.mesh) continue;
      const inView = !requiredKeys || requiredKeys.has(key);
      const visible = entry.mesh.visible === true;
      const loading = this._inflight.has(key);
      if (!inView && !visible && !loading) continue;

      const lod = Number(entry.lod) || 0;
      let state;
      if (loading) {
        state = STATE_LOADING;
      } else if (visible) {
        state = lod === 0 ? STATE_RESIDENT_HI : STATE_RESIDENT_LO;
      } else {
        state = 'hidden';
      }
      pushKey(key, state, lod, visible);
    }

    for (const key of this._inflight) {
      if (this._cells.has(key)) continue;
      if (requiredKeys && !requiredKeys.has(key)) continue;
      pushKey(key, STATE_LOADING, 99, false);
    }

    return out;
  }

  /**
   * @returns {Array<{ bounds: { minX: number, minY: number, maxX: number, maxY: number }, state: string }>}
   */
  getDisplayCells() {
    const region = this._getSceneRegion();
    if (!this._manifest || !region) return [];
    /** @type {Array<{ bounds: { minX: number, minY: number, maxX: number, maxY: number }, state: string }>} */
    const out = [];
    for (const [key, state] of this._cellStates) {
      const parts = key.split(',');
      if (parts.length !== 2) continue;
      out.push({
        bounds: imageCellToWorldBounds(
          Number(parts[0]),
          Number(parts[1]),
          this._cellSize,
          this._manifest.sourceWidth,
          this._manifest.sourceHeight,
          region,
        ),
        state,
      });
    }
    return out;
  }

  dispose() {
    this._decodeEpoch += 1;
    for (const [cellKey, entry] of this._cells) {
      try {
        const tex = entry.mesh?.material?.map;
        this._bus._unregisterStreamingMesh?.(this._cellBusKey(cellKey));
        entry.mesh?.removeFromParent?.();
        entry.mesh?.geometry?.dispose?.();
        entry.mesh?.material?.dispose?.();
        getTextureBudgetTracker().unregister(tex);
      } catch (_) {}
    }
    this._cells.clear();
    this._cellStates.clear();
    this._inflight.clear();
    if (this._fallbackMesh) {
      try {
        getTextureBudgetTracker().unregister(this._fallbackMesh.material?.map);
        this._fallbackMesh.removeFromParent();
        this._fallbackMesh.geometry?.dispose?.();
        this._fallbackMesh.material?.dispose?.();
      } catch (_) {}
      this._fallbackMesh = null;
    }
    for (const mesh of this._fallbackCellMeshes) {
      try {
        const tex = mesh.material?.map;
        const fbKey = mesh.userData?.tileId;
        if (fbKey) this._bus._unregisterStreamingMesh?.(fbKey);
        getTextureBudgetTracker().unregister(tex);
        mesh.removeFromParent();
        mesh.geometry?.dispose?.();
        mesh.material?.dispose?.();
      } catch (_) {}
    }
    this._fallbackCellMeshes = [];
    this._manifest = null;
    this._sceneRegion = null;
  }
}

/**
 * Returns true when a background should use streaming (large image or scene).
 * @param {number} width
 * @param {number} height
 * @param {number} [threshold=4096]
 */
export function shouldStreamBackground(width, height, threshold = 4096) {
  return Math.max(width, height) > threshold;
}

/**
 * Image-space cells overlapping a world view rect within a mapped region.
 *
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} viewRect
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} region
 * @param {number} cellSize
 * @param {number} sourceW
 * @param {number} sourceH
 * @returns {Array<{ cellX: number, cellY: number, key: string }>}
 */
export function getImageCellsForWorldView(viewRect, region, cellSize, sourceW, sourceH) {
  if (!viewRect || !region || !(sourceW > 0 && sourceH > 0)) return [];
  const inter = intersectRects(viewRect, region);
  if (!inter) return [];

  const rw = Math.max(1, region.maxX - region.minX);
  const rh = Math.max(1, region.maxY - region.minY);
  const cs = Math.max(1, cellSize);

  const uMin = (inter.minX - region.minX) / rw;
  const uMax = (inter.maxX - region.minX) / rw;
  const vMin = (inter.minY - region.minY) / rh;
  const vMax = (inter.maxY - region.minY) / rh;

  const pxMin = Math.max(0, uMin * sourceW);
  const pxMax = Math.min(sourceW, uMax * sourceW);
  const pyMin = Math.max(0, (1 - vMax) * sourceH);
  const pyMax = Math.min(sourceH, (1 - vMin) * sourceH);

  const minCX = Math.floor(pxMin / cs);
  const maxCX = Math.floor(Math.max(pxMin, pxMax - 1e-6) / cs);
  const minCY = Math.floor(pyMin / cs);
  const maxCY = Math.floor(Math.max(pyMin, pyMax - 1e-6) / cs);

  /** @type {Array<{ cellX: number, cellY: number, key: string }>} */
  const out = [];
  for (let cy = minCY; cy <= maxCY; cy += 1) {
    for (let cx = minCX; cx <= maxCX; cx += 1) {
      out.push({ cellX: cx, cellY: cy, key: `${cx},${cy}` });
    }
  }
  return out;
}

/**
 * Map an image pyramid cell to world bounds inside a region.
 *
 * @param {number} cellX
 * @param {number} cellY
 * @param {number} cellSize
 * @param {number} sourceW
 * @param {number} sourceH
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} region
 */
export function imageCellToWorldBounds(cellX, cellY, cellSize, sourceW, sourceH, region) {
  const cs = Math.max(1, cellSize);
  const rw = Math.max(1, region.maxX - region.minX);
  const rh = Math.max(1, region.maxY - region.minY);

  const pxMin = cellX * cs;
  const pyMin = cellY * cs;
  const pxMax = Math.min(sourceW, pxMin + cs);
  const pyMax = Math.min(sourceH, pyMin + cs);

  return {
    minX: region.minX + (pxMin / sourceW) * rw,
    maxX: region.minX + (pxMax / sourceW) * rw,
    minY: region.minY + (1 - pyMax / sourceH) * rh,
    maxY: region.minY + (1 - pyMin / sourceH) * rh,
  };
}

/**
 * Tiled mesh grid for a world-positioned region (oversized Foundry tiles).
 */
export class StreamedRegionGrid {
  /**
   * @param {import('../compositor-v2/FloorRenderBus.js').FloorRenderBus} bus
   */
  constructor(bus) {
    this._bus = bus;
    this._scene = bus?.getScene?.() ?? null;
    this._src = '';
    this._key = '';
    this._floorIndex = 0;
    this._region = null;
    this._worldH = 1000;
    this._z = 0;
    this._rotation = 0;
    this._manifest = null;
    this._fallbackMesh = null;
    /** @type {Map<string, { mesh: import('three').Object3D, lod: number }>} */
    this._cells = new Map();
    /** @type {Map<string, import('./streaming-grid.js').StreamingCellState>} */
    this._cellStates = new Map();
    this._cellSize = 2048;
    this._maxLod = 4;
    this._decodeEpoch = 0;
    /** @type {Set<string>} */
    this._inflight = new Set();
    this._maxConcurrent = 4;
    /** Coarsest LOD we have committed to — hysteresis prevents load/evict thrash. */
    this._servedLod = 99;
    this._syncKey = '';
    /** @type {Map<string, number>} */
    this._cellLastUsed = new Map();
  }

  /** @private */
  _maxTotalResidentCells() {
    const mp = estimateSceneMegapixels();
    if (mp >= 144) return 6;
    if (mp > 64) return 10;
    return maxTotalResidentCellsForScene();
  }

  /**
   * @param {import('../assets/TextureBudgetTracker.js').TextureBudgetTracker} [_tracker]
   * @param {number} [maxEvict=4]
   * @returns {number}
   */
  evictCells(_tracker, maxEvict = 4) {
    if (!this._cells.size) return 0;
    /** @type {Array<{ key: string, entry: { mesh: import('three').Object3D, lod: number }, visible: boolean, lod: number }>} */
    const candidates = [];
    for (const [key, entry] of this._cells) {
      candidates.push({
        key,
        entry,
        visible: !!entry?.mesh?.visible,
        lod: Number(entry?.lod) || 0,
      });
    }
    candidates.sort((a, b) => {
      if (a.visible !== b.visible) return a.visible ? 1 : -1;
      const ageA = this._cellLastUsed.get(a.key) ?? 0;
      const ageB = this._cellLastUsed.get(b.key) ?? 0;
      if (ageA !== ageB) return ageA - ageB;
      return b.lod - a.lod;
    });
    let evicted = 0;
    for (const { key, entry, visible } of candidates) {
      if (evicted >= maxEvict) break;
      if (visible) continue;
      this._disposeCell(key, entry);
      evicted += 1;
    }
    return evicted;
  }

  /** @private */
  _disposeCell(key, entry) {
    try {
      const tex = entry?.mesh?.material?.map;
      this._bus._unregisterStreamingMesh?.(`${this._key}:${key}`);
      entry.mesh?.removeFromParent?.();
      entry.mesh?.geometry?.dispose?.();
      entry.mesh?.material?.dispose?.();
      getTextureBudgetTracker().unregister(tex);
    } catch (_) {}
    this._cellLastUsed.delete(key);
    this._cells.delete(key);
    this._setCellState(key, STATE_CULLED);
  }

  /** @private */
  _effectiveLod(lod) {
    const budget = getTextureBudgetTracker();
    let effective = Math.max(0, Math.floor(Number(lod) || 0));
    const used = budget.getUsedFraction();
    if (used > 0.98) {
      effective = Math.min(this._maxLod, effective + 1);
    }
    return Math.min(effective, this._maxLod);
  }

  /**
   * @param {{ key: string }} cell
   * @param {number} effectiveLod
   * @returns {boolean}
   * @private
   */
  _cellNeedsWork(cell, effectiveLod) {
    if (this._inflight.has(cell.key)) return false;
    const existing = this._cells.get(cell.key);
    if (!existing?.mesh) return true;
    if (!existing.mesh.visible) return true;
    return Number(existing.lod) > effectiveLod;
  }

  /** @private */
  _stabilizeLod(requestedLod) {
    const budget = getTextureBudgetTracker();
    const req = Math.max(0, Math.floor(Number(requestedLod) || 0));
    if (this._servedLod === 99 || req < this._servedLod) {
      this._servedLod = req;
    } else if (req > this._servedLod && budget.getUsedFraction() > 0.98) {
      this._servedLod = req;
    }
    return Math.min(this._servedLod, this._maxLod);
  }

  /** @param {number} lod */
  notifyZoomLod(lod) {
    const req = Math.max(0, Math.floor(Number(lod) || 0));
    if (req < this._servedLod || this._servedLod === 99) {
      this._servedLod = req;
    }
    this._syncKey = '';
  }

  /**
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} viewRect
   * @param {number} lod
   * @returns {boolean}
   */
  hasPendingCellWork(viewRect, lod) {
    if (!this._manifest || !viewRect || !this._region) return false;
    const effectiveLod = this._stabilizeLod(this._effectiveLod(lod));
    const required = getImageCellsForWorldView(
      viewRect,
      this._region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
    );
    if (this._inflight.size > 0) return true;
    return required.some((cell) => this._cellNeedsWork(cell, effectiveLod));
  }

  /**
   * @private
   */
  _scheduleRequiredCellLoads(required, effectiveLod, epoch) {
    const budget = getTextureBudgetTracker();
    for (const cell of required) {
      this._cellLastUsed.set(cell.key, performance.now());
      const existing = this._cells.get(cell.key);
      if (existing?.mesh) {
        if (existing.lod <= effectiveLod) {
          existing.mesh.visible = this._isFloorVisible();
          this._setCellState(cell.key, existing.lod === 0 ? STATE_RESIDENT_HI : STATE_RESIDENT_LO);
          continue;
        }
        existing.mesh.visible = this._isFloorVisible();
        if (this._inflight.has(cell.key)) continue;
        if (this._inflight.size >= this._maxConcurrent) continue;
        this._setCellState(cell.key, STATE_LOADING);
        this._inflight.add(cell.key);
        void this._loadCell(cell.cellX, cell.cellY, effectiveLod, epoch);
        continue;
      }
      if (this._inflight.has(cell.key)) continue;
      if (this._inflight.size >= this._maxConcurrent) continue;
      if (this._cells.size >= this._maxTotalResidentCells()) {
        this.evictCells(budget, 1);
      }

      this._setCellState(cell.key, STATE_LOADING);
      this._inflight.add(cell.key);
      void this._loadCell(cell.cellX, cell.cellY, effectiveLod, epoch);
    }
  }

  /** @private */
  _isFloorVisible() {
    const maxFloor = Number.isFinite(Number(this._bus?._visibleMaxFloorIndex))
      ? Number(this._bus._visibleMaxFloorIndex)
      : Infinity;
    return this._floorIndex <= maxFloor && !this._bus?._suppressTileAlbedoForEditing;
  }

  /** @private */
  _applyRequiredCellVisibility(required) {
    const floorVis = this._isFloorVisible();
    const now = performance.now();
    for (const cell of required) {
      this._cellLastUsed.set(cell.key, now);
      const existing = this._cells.get(cell.key);
      if (existing?.mesh) {
        existing.mesh.visible = floorVis;
        if (floorVis) {
          const lod = Number(existing.lod) || 0;
          this._setCellState(cell.key, lod === 0 ? STATE_RESIDENT_HI : STATE_RESIDENT_LO);
        }
      }
    }
  }

  /**
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} viewRect
   */
  reconcileVisibility(viewRect) {
    if (!this._manifest || !viewRect || !this._region) return;
    const required = getImageCellsForWorldView(
      viewRect,
      this._region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
    );
    this._applyRequiredCellVisibility(required);
    if (this._fallbackMesh) {
      const hasStreamedCover = [...this._cells.values()].some((e) => {
        const img = e?.mesh?.material?.map?.image;
        return !!e?.mesh?.visible && !!(img && (img.width > 0 || img.height > 0));
      });
      this._fallbackMesh.visible = this._isFloorVisible() && !hasStreamedCover;
    }
  }

  /** @returns {Map<string, import('./streaming-grid.js').StreamingCellState>} */
  getCellStates() {
    return this._cellStates;
  }

  /**
   * @param {string} src
   * @param {object} options
   * @param {string} options.key
   * @param {number} options.floorIndex
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} options.region
   * @param {number} [options.worldH]
   * @param {number} [options.z]
   * @param {number} [options.rotation]
   */
  async mount(src, options) {
    this.dispose();
    this._src = src;
    this._key = options.key;
    this._floorIndex = options.floorIndex ?? 0;
    this._region = options.region;
    this._worldH = options.worldH ?? 1000;
    this._z = options.z ?? 0;
    this._rotation = options.rotation ?? 0;
    this._decodeEpoch += 1;

    const budget = getTextureBudgetTracker();
    this._cellSize = budget.getRecommendedTileSize();
    this._maxLod = budget.getMaxLodLevel();

    this._manifest = await buildPyramidManifest(src, this._cellSize, this._maxLod);
    if (!this._manifest || !this._region) {
      log.warn('StreamedRegionGrid: manifest/region failed', src);
      return;
    }

    const mp = estimateSceneMegapixels();
    this._maxConcurrent = mp >= 144 ? 2 : mp > 64 ? 3 : 4;

    const fallbackMax = Math.min(2048, budget.backgroundMaxSize ?? 2048);
    const fallbackTex = await loadFallbackTexture(src, fallbackMax);
    if (fallbackTex && this._scene && this._region) {
      this._fallbackMesh = this._createRegionMesh(
        this._region,
        fallbackTex,
        `${this._key}__fallback`,
        true,
      );
      getTextureBudgetTracker().register(
        fallbackTex,
        `stream:fallback:${this._key}`,
        estimateTextureBytes(fallbackTex.image?.width ?? 512, fallbackTex.image?.height ?? 512, 'ubyte'),
        { source: 'streamFallback' },
      );
    }
  }

  /**
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} viewRect
   * @param {number} lod
   * @param {{ sharpenOnZoom?: boolean }} [options]
   */
  async syncToView(viewRect, lod, options = {}) {
    if (!this._manifest || !viewRect || !this._region) return;

    if (!this._isFloorVisible()) {
      for (const [key, entry] of [...this._cells.entries()]) {
        this._disposeCell(key, entry);
      }
      if (this._fallbackMesh) this._fallbackMesh.visible = false;
      return;
    }

    const epoch = this._decodeEpoch;
    const effectiveLod = this._stabilizeLod(this._effectiveLod(lod));
    const required = getImageCellsForWorldView(
      viewRect,
      this._region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
    );
    const requiredKeys = new Set(required.map((c) => c.key));
    const syncKey = buildViewSyncKey(effectiveLod, requiredKeys);
    const needsSharpen = options.sharpenOnZoom && required.some((cell) => {
      const existing = this._cells.get(cell.key);
      return !!existing?.mesh && Number(existing.lod) > effectiveLod;
    });
    const needsLoad = required.some((cell) => this._cellNeedsWork(cell, effectiveLod));
    const budget = getTextureBudgetTracker();
    if (budget.getUsedFraction() > 1.0 && (needsSharpen || needsLoad)) {
      this.evictCells(budget, 4);
    }
    if (syncKey === this._syncKey && !needsSharpen && !needsLoad) {
      this._applyRequiredCellVisibility(required);
      if (this._fallbackMesh) {
        const hasStreamedCover = [...this._cells.values()].some((e) => {
          const img = e?.mesh?.material?.map?.image;
          return !!e?.mesh?.visible && !!(img && (img.width > 0 || img.height > 0));
        });
        this._fallbackMesh.visible = this._isFloorVisible() && !hasStreamedCover;
      }
      return;
    }
    this._syncKey = syncKey;

    for (const [key, entry] of this._cells) {
      if (!requiredKeys.has(key)) {
        this._setCellState(key, STATE_CULLED);
        if (entry?.mesh) entry.mesh.visible = false;
      }
    }

    this._scheduleRequiredCellLoads(required, effectiveLod, epoch);

    if (this._fallbackMesh) {
      const hasStreamedCover = [...this._cells.values()].some((e) => {
        const img = e?.mesh?.material?.map?.image;
        return !!e?.mesh?.visible && !!(img && (img.width > 0 || img.height > 0));
      });
      this._fallbackMesh.visible = this._isFloorVisible() && !hasStreamedCover;
    }
  }

  /** @private */
  async _loadCell(cellX, cellY, lod, epoch) {
    const key = `${cellX},${cellY}`;
    try {
      if (epoch !== this._decodeEpoch) return;
      const tex = await loadPyramidTileTexture(
        this._src,
        cellX,
        cellY,
        lod,
        this._cellSize,
        this._manifest.sourceWidth,
        this._manifest.sourceHeight,
      );
      if (epoch !== this._decodeEpoch || !tex || !this._region) return;

      const old = this._cells.get(key);
      if (old?.mesh) {
        this._disposeCell(key, old);
      }

      const bounds = imageCellToWorldBounds(
        cellX,
        cellY,
        this._cellSize,
        this._manifest.sourceWidth,
        this._manifest.sourceHeight,
        this._region,
      );
      const mesh = this._createRegionMesh(bounds, tex, `${this._key}:${key}`, false, lod);
      this._cells.set(key, { mesh, lod });
      this._setCellState(key, lod === 0 ? STATE_RESIDENT_HI : STATE_RESIDENT_LO);

      getTextureBudgetTracker().register(
        tex,
        `stream:cell:${this._key}:${key}:L${lod}`,
        estimateTextureBytes(tex.image?.width ?? 256, tex.image?.height ?? 256, 'ubyte'),
        { source: 'streamTile' },
      );
    } finally {
      this._inflight.delete(key);
    }
  }

  /** @private */
  _setCellState(key, state) {
    this._cellStates.set(key, state);
  }

  /**
   * @private
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} bounds
   */
  _createRegionMesh(bounds, texture, busKey, isFallback, lod = 0) {
    const THREE = window.THREE;
    if (!THREE || !this._scene) return null;

    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxY - bounds.minY;
    const centerX = bounds.minX + w / 2;
    const centerY = bounds.minY + h / 2;

    texture.flipY = false;
    texture.needsUpdate = true;

    const geom = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.scale.set(1, -1, 1);
    mesh.position.set(centerX, centerY, this._z + (isFallback ? -0.001 : 0.002 + lod * 0.0001));
    mesh.rotation.z = this._rotation;
    mesh.renderOrder = isFallback ? 0 : 1 + lod;
    mesh.userData = {
      tileId: busKey,
      mapShineStreaming: true,
      mapShineStreamingFallback: isFallback,
      mapShineStreamingCell: !isFallback,
      floorIndex: this._floorIndex,
    };
    this._scene.add(mesh);
    this._bus._registerStreamingMesh?.(busKey, mesh, mat, this._floorIndex);
    mesh.visible = this._isFloorVisible();
    return mesh;
  }

  /**
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }|null} [viewRect]
   * @returns {Array<{ bounds: object, state: string, lod: number, visible: boolean }>}
   */
  getMinimapDisplayCells(viewRect = null) {
    if (!this._manifest || !this._region) return [];

    /** @type {Set<string>|null} */
    let requiredKeys = null;
    if (viewRect) {
      requiredKeys = new Set(
        getImageCellsForWorldView(
          viewRect,
          this._region,
          this._cellSize,
          this._manifest.sourceWidth,
          this._manifest.sourceHeight,
        ).map((c) => c.key),
      );
    }

    /** @type {Array<{ bounds: object, state: string, lod: number, visible: boolean }>} */
    const out = [];

    const pushKey = (key, state, lod, visible) => {
      const parts = key.split(',');
      if (parts.length !== 2) return;
      out.push({
        bounds: imageCellToWorldBounds(
          Number(parts[0]),
          Number(parts[1]),
          this._cellSize,
          this._manifest.sourceWidth,
          this._manifest.sourceHeight,
          this._region,
        ),
        state,
        lod,
        visible,
      });
    };

    for (const [key, entry] of this._cells) {
      if (!entry?.mesh) continue;
      const inView = !requiredKeys || requiredKeys.has(key);
      const visible = entry.mesh.visible === true;
      const loading = this._inflight.has(key);
      if (!inView && !visible && !loading) continue;

      const lod = Number(entry.lod) || 0;
      let state;
      if (loading) {
        state = STATE_LOADING;
      } else if (visible) {
        state = lod === 0 ? STATE_RESIDENT_HI : STATE_RESIDENT_LO;
      } else {
        state = 'hidden';
      }
      pushKey(key, state, lod, visible);
    }

    for (const key of this._inflight) {
      if (this._cells.has(key)) continue;
      if (requiredKeys && !requiredKeys.has(key)) continue;
      pushKey(key, STATE_LOADING, 99, false);
    }

    return out;
  }

  /**
   * @returns {Array<{ bounds: { minX: number, minY: number, maxX: number, maxY: number }, state: string }>}
   */
  getDisplayCells() {
    /** @type {Array<{ bounds: { minX: number, minY: number, maxX: number, maxY: number }, state: string }>} */
    const out = [];
    if (!this._manifest || !this._region) return out;
    for (const [key, state] of this._cellStates) {
      const parts = key.split(',');
      if (parts.length !== 2) continue;
      out.push({
        bounds: imageCellToWorldBounds(
          Number(parts[0]),
          Number(parts[1]),
          this._cellSize,
          this._manifest.sourceWidth,
          this._manifest.sourceHeight,
          this._region,
        ),
        state,
      });
    }
    return out;
  }

  /** Drop resident cells for cache/schema reload. */
  reloadAllCells() {
    for (const [key, entry] of [...this._cells.entries()]) {
      try {
        const tex = entry?.mesh?.material?.map;
        this._bus._unregisterStreamingMesh?.(`${this._key}:${key}`);
        entry.mesh?.removeFromParent?.();
        entry.mesh?.geometry?.dispose?.();
        entry.mesh?.material?.dispose?.();
        getTextureBudgetTracker().unregister(tex);
      } catch (_) {}
      this._cells.delete(key);
      this._setCellState(key, STATE_CULLED);
    }
    this._decodeEpoch += 1;
    this._servedLod = 99;
    this._syncKey = '';
    this._cellLastUsed.clear();
  }

  dispose() {
    this._decodeEpoch += 1;
    for (const [key, entry] of this._cells) {
      try {
        this._bus._unregisterStreamingMesh?.(`${this._key}:${key}`);
        entry.mesh?.removeFromParent?.();
        entry.mesh?.geometry?.dispose?.();
        entry.mesh?.material?.dispose?.();
        getTextureBudgetTracker().unregister(entry.mesh?.material?.map);
      } catch (_) {}
    }
    this._cells.clear();
    this._cellStates.clear();
    this._inflight.clear();
    if (this._fallbackMesh) {
      try {
        this._bus._unregisterStreamingMesh?.(`${this._key}__fallback`);
        getTextureBudgetTracker().unregister(this._fallbackMesh.material?.map);
        this._fallbackMesh.removeFromParent();
        this._fallbackMesh.geometry?.dispose?.();
        this._fallbackMesh.material?.dispose?.();
      } catch (_) {}
      this._fallbackMesh = null;
    }
    this._manifest = null;
  }
}

/**
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} tileBounds
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} view
 */
export function tileBoundsIntersectView(tileBounds, view) {
  return rectsIntersect(tileBounds, view);
}
