/**
 * @fileoverview Tiled background mesh grid with low-res fallback for FloorRenderBus.
 * @module streaming/streamed-background-grid
 */

import { createLogger } from '../core/log.js';
import { GROUND_Z } from '../compositor-v2/LayerOrderPolicy.js';
import { TILE_FEATURE_LAYERS } from '../core/render-layers.js';
import { intersectRects, rectsIntersect, scaleStreamingResidentCap } from './streaming-grid.js';
import {
  buildPyramidManifest,
  loadPyramidTileTexture,
  loadFallbackTexture,
  adoptPyramidTileTexture,
  releasePyramidTileTexture,
  DECODE_PRIORITY,
  hashSourceKey,
  reprioritizeDecodeQueueForSharpen,
} from './texture-pyramid-builder.js';
import { isHugeImageSource } from './probe-image-dimensions.js';
import { loadImageTexture } from '../assets/image-texture-loader.js';
import { getTextureBudgetTracker, estimateTextureBytes } from '../assets/TextureBudgetTracker.js';
import { getCameraGroundCenter, getSceneRegionFromFoundryData } from './view-projection-service.js';
import { estimateSceneMegapixels } from './texture-budget-policy.js';
import { getGpuWorkScheduler, GPU_WORK_PRIORITY } from './gpu-work-scheduler.js';

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

/** Only the camera-centered tile is ring 0; ring 1 is the immediate neighbor shell. */
const FOCAL_RING = 0;
/** Inner frustum rings that always target zoom-native LOD (focal + neighbors). */
const INNER_SHARP_RING_MAX = 2;
/** Hard per-grid inflight cap — inner-ring bypass must not exceed this. */
const GRID_INFLIGHT_HARD_CAP = 10;
/**
 * Largest focal ring permitted to load *finer* than the zoom-native LOD. Keeping
 * this tiny (focal cell + immediate neighbors) prevents the whole frustum from
 * jumping to LOD 0 — the burst that tripped GPU context loss.
 */
const FOCAL_SHARPEN_RING_MAX = 2;
/** Only sharpen below zoom-native LOD when software budget headroom exists. */
const FOCAL_SHARPEN_MAX_USED = 0.88;
/** View must be settled (no pan / zoom / required-set change) this long to sharpen. */
const FOCAL_SHARPEN_IDLE_MS = 120;

/**
 * Integer renderOrder for streamed cells — fallbacks draw beneath resident tiles.
 * @param {number} baseOrder
 * @param {number} lod
 * @param {boolean} [isFallback=false]
 * @returns {number}
 */
function streamingCellRenderOrder(baseOrder, lod, isFallback = false) {
  const base = Math.floor(Number(baseOrder) || 0);
  const level = Math.max(0, Math.floor(Number(lod) || 0));
  if (isFallback) return base * 10;
  // LOD 0 = sharpest — draw last (highest renderOrder) over coarser cells during progressive load.
  return base * 10 + 9 - Math.min(8, level);
}

/**
 * Z offset for a streaming cell by LOD (sharper = slightly closer when depthTest is enabled).
 * @param {number} lod
 * @param {boolean} [isFallback=false]
 * @returns {number}
 */
function streamingCellLodZOffset(lod, isFallback = false) {
  if (isFallback) return -0.001;
  const level = Math.max(0, Math.floor(Number(lod) || 0));
  return 0.01 - level * 0.001;
}

/**
 * Release GPU memory for a streaming mesh albedo texture.
 * @param {import('three').Texture|null|undefined} tex
 */
function disposeStreamingTexture(tex) {
  if (!tex) return;
  try {
    if (tex.userData?.mapShineStreamingTileKey) {
      releasePyramidTileTexture(tex);
    } else {
      tex.dispose();
    }
  } catch (_) {}
}

/**
 * Tear down a streaming mesh and its texture budget entry.
 * @param {import('three').Mesh|null|undefined} mesh
 * @param {import('../assets/TextureBudgetTracker.js').TextureBudgetTracker} [tracker]
 */
function disposeStreamingMesh(mesh, tracker = getTextureBudgetTracker()) {
  if (!mesh) return;
  try {
    const tex = mesh.material?.map ?? null;
    tracker.unregister(tex);
    if (mesh.material) mesh.material.map = null;
    disposeStreamingTexture(tex);
    mesh.removeFromParent?.();
    mesh.geometry?.dispose?.();
    mesh.material?.dispose?.();
  } catch (_) {}
}

/** @param {number} effectiveLod @param {Iterable<string>} requiredKeys */
function buildViewSyncKey(effectiveLod, requiredKeys) {
  return `${effectiveLod}:${[...requiredKeys].sort().join(',')}`;
}

/**
 * Re-read texture budget policy into an mounted grid (cell size / manifest / concurrency).
 * @param {{ _src: string, _cellSize: number, _maxLod: number, _maxConcurrent: number, _manifest: object|null, _syncKey: string }} grid
 */
async function refreshGridCellPolicy(grid) {
  const budget = getTextureBudgetTracker();
  const newCellSize = budget.getRecommendedTileSize();
  if (!grid._src || newCellSize === grid._cellSize) return;
  grid._cellSize = newCellSize;
  grid._maxLod = budget.getMaxLodLevel();
  const mp = estimateSceneMegapixels();
  grid._maxConcurrent = mp >= 144 ? (grid._cellSize <= 1024 ? 3 : 2) : mp > 64 ? 3 : 4;
  const manifest = await buildPyramidManifest(grid._src, grid._cellSize, grid._maxLod);
  if (manifest) grid._manifest = manifest;
  grid._syncKey = '';
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

/**
 * Image pyramid cell containing a world-space ground point.
 *
 * @param {number} worldX
 * @param {number} worldY
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} region
 * @param {number} cellSize
 * @param {number} sourceW
 * @param {number} sourceH
 * @returns {{ cellX: number, cellY: number, key: string }|null}
 */
export function worldPointToImageCell(worldX, worldY, region, cellSize, sourceW, sourceH) {
  if (!region || !(sourceW > 0 && sourceH > 0)) return null;
  const rw = Math.max(1, region.maxX - region.minX);
  const rh = Math.max(1, region.maxY - region.minY);
  const u = (worldX - region.minX) / rw;
  const v = (worldY - region.minY) / rh;
  const px = u * sourceW;
  const py = (1 - v) * sourceH;
  const cs = Math.max(1, cellSize);
  const cellX = Math.floor(px / cs);
  const cellY = Math.floor(py / cs);
  if (cellX < 0 || cellY < 0) return null;
  if (cellX * cs >= sourceW || cellY * cs >= sourceH) return null;
  return { cellX, cellY, key: `${cellX},${cellY}` };
}

/**
 * Chebyshev ring index for spiral-outward tile priority (0 = focal cell).
 *
 * @param {number} focalCellX
 * @param {number} focalCellY
 * @param {number} cellX
 * @param {number} cellY
 * @returns {number}
 */
export function imageCellChebyshevRing(focalCellX, focalCellY, cellX, cellY) {
  return Math.max(Math.abs(cellX - focalCellX), Math.abs(cellY - focalCellY));
}

/**
 * Resolve the image cell under the camera center for a mapped region.
 *
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} region
 * @param {number} cellSize
 * @param {number} sourceW
 * @param {number} sourceH
 * @returns {{ cellX: number, cellY: number, key: string }|null}
 */
export function resolveFocalImageCell(region, cellSize, sourceW, sourceH, viewRect = null) {
  let wx = NaN;
  let wy = NaN;
  const cam = getCameraGroundCenter();
  if (cam) {
    wx = cam.x;
    wy = cam.y;
  } else {
    const pos = window.MapShine?.sceneComposer?.camera?.position
      ?? window.MapShine?.floorCompositorV2?.camera?.position;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      wx = pos.x;
      wy = pos.y;
    } else if (viewRect) {
      wx = (viewRect.minX + viewRect.maxX) * 0.5;
      wy = (viewRect.minY + viewRect.maxY) * 0.5;
    }
  }
  if (!Number.isFinite(wx) || !Number.isFinite(wy)) return null;
  return worldPointToImageCell(wx, wy, region, cellSize, sourceW, sourceH);
}

/** @returns {number} */
function maxTotalResidentCellsForScene(cellSize = 1024) {
  const mp = estimateSceneMegapixels();
  if (mp >= 144) return scaleStreamingResidentCap(18, cellSize);
  if (mp > 64) return scaleStreamingResidentCap(24, cellSize);
  return scaleStreamingResidentCap(32, cellSize);
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
    this._cellSize = options.cellSize ?? 1024;
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
    /** @type {number} */
    this._coarseFallbackLod = 3;
    /** @type {boolean} */
    this._lazyCoarseFallback = false;
    /** @type {boolean} True once coarse per-cell fallback grid is resident (never-blank coverage). */
    this._coarseBaseReady = false;
    /** @type {Set<string>} */
    this._inflightFallback = new Set();
    /** @type {boolean} */
    this._isPanning = false;
    /** @type {Set<string>} */
    this._activeRequiredKeys = new Set();
    /** @type {Map<string, number>} */
    this._pendingUpgrades = new Map();
    /** @type {number} performance.now() of the last view/zoom/required-set change. */
    this._lastViewChangeMs = 0;
    /** Base renderOrder for streamed cells (albedo or overhead band). */
    this._tileRenderOrder = 0;
  }

  /**
   * True when the view has been settled long enough to run a focal sharpen pass.
   * @param {number} used Current budget used fraction.
   * @returns {boolean}
   * @private
   */
  _sharpenPassUnlocked(used) {
    if (this._isPanning) return false;
    if (used > FOCAL_SHARPEN_MAX_USED) return false;
    try {
      if (getGpuWorkScheduler().focalSharpenEnabled === false) return false;
    } catch (_) {}
    return (performance.now() - this._lastViewChangeMs) >= FOCAL_SHARPEN_IDLE_MS;
  }

  /**
   * @param {number} used
   * @param {number} [targetLod]
   * @returns {boolean}
   * @private
   */
  _canSharpenBelowNative(used, targetLod = null) {
    if (!this._sharpenPassUnlocked(used)) return false;
    const target = Number.isFinite(Number(targetLod)) ? Math.max(0, Math.floor(Number(targetLod))) : null;
    if (target === 0) {
      try {
        if (!getGpuWorkScheduler().isLod0Allowed()) return false;
      } catch (_) {}
    }
    return true;
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
    const cs = this._cellSize || 1024;
    // Typical frustum on 12000² @ 0.3 zoom needs more cells at 1024 px than at 2048.
    if (mp >= 144) return scaleStreamingResidentCap(9, cs);
    if (mp > 64) return scaleStreamingResidentCap(12, cs);
    return scaleStreamingResidentCap(16, cs);
  }

  /** @private */
  _maxTotalResidentCells() {
    return maxTotalResidentCellsForScene(this._cellSize);
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
  _countVisibleLod0Residents() {
    let n = 0;
    for (const entry of this._cells.values()) {
      if (entry?.mesh?.visible && (Number(entry.lod) || 0) === 0) n += 1;
    }
    return n;
  }

  /** @private */
  _budgetHasHeadroom() {
    return getTextureBudgetTracker().getUsedFraction() <= 0.55;
  }

  /** @private */
  _maxInflightLoads() {
    if (window.MapShine?.__msaSceneLoading === true) {
      return Math.min(2, this._maxConcurrent);
    }
    const budget = getTextureBudgetTracker();
    const used = budget.getUsedFraction();
    if (used > 0.92) return Math.max(this._maxConcurrent, 3);
    if (!this._isPanning && this._budgetHasHeadroom()) {
      return Math.min(GRID_INFLIGHT_HARD_CAP, Math.max(this._maxConcurrent, 8));
    }
    if (this._budgetHasHeadroom()) {
      return Math.min(GRID_INFLIGHT_HARD_CAP, Math.max(this._maxConcurrent, 5));
    }
    return this._maxConcurrent;
  }

  /** @private */
  _atInflightCap() {
    return this._inflight.size >= this._maxInflightLoads();
  }

  /**
   * True when visible residents still need a finer LOD after pan stops.
   * @param {Array<{ key: string, cellX: number, cellY: number }>} required
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} viewRect
   * @param {number} requestedLod
   * @param {{ cellX: number, cellY: number }|null} focal
   * @returns {boolean}
   * @private
   */
  _hasSharpenBacklog(required, viewRect, requestedLod, focal) {
    if (this._isPanning) return false;
    if (this._countUncoveredRequired(required) > 0) return false;
    if (this._pendingUpgrades.size > 0) return true;
    return required.some((cell) => {
      const existing = this._cells.get(cell.key);
      if (!existing?.mesh) return false;
      return !this._residentLodAcceptable(
        existing.lod,
        cell,
        viewRect,
        requestedLod,
        false,
        focal,
      );
    });
  }

  /**
   * @param {{ mesh?: import('three').Object3D, lod?: number }|undefined} existing
   * @param {number|null} upgradeToLod
   * @param {number} loadLod
   * @returns {number}
   * @private
   */
  _decodePriorityForCellLoad(existing, upgradeToLod, loadLod) {
    if (upgradeToLod != null) return DECODE_PRIORITY.COVERAGE;
    if (existing?.mesh && loadLod < (Number(existing.lod) || 99)) {
      return DECODE_PRIORITY.UPGRADE;
    }
    if (!existing?.mesh) return DECODE_PRIORITY.COVERAGE;
    return DECODE_PRIORITY.STREAM;
  }

  /**
   * Cap how many visible cells may stay at LOD 0 when the software budget is tight.
   * @param {number} cellLod
   * @param {{ cellX: number, cellY: number }} cell
   * @param {{ cellX: number, cellY: number }|null} focalCell
   * @returns {number}
   * @private
   */
  _clampCellLodForBudget(cellLod, cell, focalCell) {
    if (cellLod > 0) return cellLod;

    // Post-crash recovery: forbid LOD-0 (largest) uploads entirely until cooldown
    // elapses, regardless of zoom — coarser but safe while the GPU settles.
    try { if (!getGpuWorkScheduler().isLod0Allowed()) return 1; } catch (_) {}

    const ring = this._cellFrustumRing(cell, focalCell);
    const used = getTextureBudgetTracker().getUsedFraction();
    // Frustum core may always decode LOD 0 while under the hard budget cap.
    if (ring <= INNER_SHARP_RING_MAX && used <= 1.0) return 0;
    if (used <= 0.98) return 0;

    const mp = estimateSceneMegapixels();
    let maxLod0 = scaleStreamingResidentCap(mp >= 144 ? 8 : 12, this._cellSize);
    if (this._budgetHasHeadroom()) {
      maxLod0 = scaleStreamingResidentCap(mp >= 144 ? 28 : 32, this._cellSize);
    } else if (used > 1.0) {
      maxLod0 = scaleStreamingResidentCap(mp >= 144 ? 6 : 8, this._cellSize);
    }

    const lod0Count = this._countVisibleLod0Residents();
    if (lod0Count >= maxLod0) return 1;
    return 0;
  }

  /** @private */
  _zoomNativeLod(lod) {
    return Math.min(this._maxLod, Math.max(0, Math.floor(Number(lod) || 0)));
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
   * Sharpen LOD for camera-centered rings when budget headroom allows.
   * Global zoom LOD may be 1 at moderate zoom, but the focal tile still targets LOD 0.
   *
   * @param {number} native
   * @param {number} ring
   * @param {number} used
   * @param {boolean} [isPanning=false]
   * @returns {number}
   * @private
   */
  _innerSharpLodTarget(native, ring, used, isPanning = false) {
    if (ring > INNER_SHARP_RING_MAX) return native;
    if (isPanning) return native;
    if (used > 1.0) return Math.min(this._maxLod, native + (ring === FOCAL_RING ? 1 : 0));
    // Zoom-native LOD is the ceiling for the frustum; focal rings may sharpen one level
    // when idle and under budget pressure (the LightingEffectV2 RT leak was the real crash cause).
    const sharpenTarget = Math.max(0, native - 1);
    if (ring <= FOCAL_SHARPEN_RING_MAX && this._canSharpenBelowNative(used, sharpenTarget)) {
      return sharpenTarget;
    }
    return native;
  }

  /**
   * Per-cell LOD target — camera-centered tile keeps full resolution under VRAM pressure.
   * @param {{ cellX: number, cellY: number }} cell
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} viewRect
   * @param {number} lod
   * @param {{ cellX: number, cellY: number }|null} [focalCell]
   * @returns {number}
   * @private
   */
  _effectiveLodForCell(cell, viewRect, lod, focalCell = null) {
    const native = this._zoomNativeLod(lod);
    const budget = getTextureBudgetTracker();
    const used = budget.getUsedFraction();
    if (!this._manifest) return native;

    const region = this._getSceneRegion();
    if (!region) return native;

    const focal = focalCell ?? resolveFocalImageCell(
      region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
    );
    if (!focal) {
      if (!viewRect || used <= 0.92) return native;
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
      if (dist <= 0.5) return native;
      if (used > 1.0) return Math.min(this._maxLod, native + (dist <= 1.05 ? 1 : 2));
      if (used > 0.96) return Math.min(this._maxLod, native + 1);
      return native;
    }

    const ring = imageCellChebyshevRing(focal.cellX, focal.cellY, cell.cellX, cell.cellY);

    if (ring <= INNER_SHARP_RING_MAX) {
      return this._innerSharpLodTarget(native, ring, used, this._isPanning);
    }

    // Outer rings: zoom-native LOD is the ceiling — only ever coarsen under VRAM
    // pressure, never sharpen finer than the zoom needs.
    if (used <= 0.92) return native;
    if (ring === 2 && used <= 0.96) return native;
    if (used > 1.0) return Math.min(this._maxLod, native + (ring <= 3 ? 1 : 2));
    if (used > 0.96) return Math.min(this._maxLod, native + (ring <= 2 ? 0 : 1));
    return native;
  }

  /**
   * @param {{ cellX: number, cellY: number }} cell
   * @param {{ cellX: number, cellY: number }|null} focalCell
   * @returns {number}
   * @private
   */
  _cellFrustumRing(cell, focalCell) {
    if (!focalCell) return 9999;
    return imageCellChebyshevRing(focalCell.cellX, focalCell.cellY, cell.cellX, cell.cellY);
  }

  /**
   * @param {{ cellX: number, cellY: number }} cell
   * @param {{ cellX: number, cellY: number }|null} focalCell
   * @returns {boolean}
   * @private
   */
  _isFocalCell(cell, focalCell) {
    return !!focalCell
      && cell.cellX === focalCell.cellX
      && cell.cellY === focalCell.cellY;
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
  _residentLodAcceptable(existingLod, cell, viewRect, requestedLod, panStabilize = false, focalCell = null) {
    const el = Number(existingLod) || 0;
    const nativeLod = this._zoomNativeLod(requestedLod);
    const zoomLod = this._effectiveLod(requestedLod);
    const focal = focalCell ?? (this._manifest && this._getSceneRegion()
      ? resolveFocalImageCell(
        this._getSceneRegion(),
        this._cellSize,
        this._manifest.sourceWidth,
        this._manifest.sourceHeight,
      )
      : null);
    const ring = this._cellFrustumRing(cell, focal);
    const cellTarget = viewRect
      ? this._effectiveLodForCell(cell, viewRect, requestedLod, focal)
      : zoomLod;

    if (ring <= INNER_SHARP_RING_MAX) {
      if (el <= cellTarget) return true;
      return false;
    }

    if (el <= cellTarget) return true;
    if (panStabilize) {
      const panFloor = Math.min(cellTarget, zoomLod + this._vramLodSlack());
      return el <= panFloor;
    }
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
  _cellNeedsWork(cell, viewRect, requestedLod, options = {}, focalCell = null) {
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
      focalCell,
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
    if (!this._isFloorVisible()) return false;
    const region = this._getSceneRegion();
    if (!this._manifest || !viewRect || !region) return false;
    const required = getImageCellsForWorldView(
      viewRect,
      region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
    );
    const requiredKeys = new Set(required.map((c) => c.key));
    const inflightActive = [...this._inflight].some((k) => requiredKeys.has(k))
      || [...this._inflightFallback].some((k) => requiredKeys.has(k));
    if (inflightActive) return true;
    if (!this._isPanning && this._pendingUpgrades.size > 0) return true;
    if (this._countUncoveredRequired(required) > 0) return true;

    const budget = getTextureBudgetTracker();
    const overBudget = budget.getUsedFraction() > 1.0;
    const focal = resolveFocalImageCell(
      region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
      viewRect,
    );

    if (this._hasSharpenBacklog(required, viewRect, lod, focal)) return true;

    if (overBudget) {
      return required.some((cell) => {
        if (this._inflight.has(cell.key)) return true;
        const entry = this._cells.get(cell.key);
        if (!entry?.mesh || !entry.mesh.visible) return true;
        const ring = focal ? this._cellFrustumRing(cell, focal) : 9999;
        if (ring > INNER_SHARP_RING_MAX) return false;
        return !this._residentLodAcceptable(
          entry.lod,
          cell,
          viewRect,
          lod,
          false,
          focal,
        );
      });
    }

    return required.some((cell) =>
      this._cellNeedsWork(cell, viewRect, lod, { panStabilize: false }, focal),
    );
  }

  /**
   * True when visible residents still need a focal sharpen pass (manager sync pump).
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} viewRect
   * @param {number} lod
   * @returns {boolean}
   */
  hasSharpenBacklog(viewRect, lod) {
    const region = this._getSceneRegion();
    if (!this._manifest || !viewRect || !region) return false;
    const required = getImageCellsForWorldView(
      viewRect,
      region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
    );
    const focal = resolveFocalImageCell(
      region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
      viewRect,
    );
    return this._hasSharpenBacklog(required, viewRect, lod, focal);
  }

  /**
   * Drop inflight keys for cells that left the required view set.
   * @param {Set<string>} requiredKeys
   * @private
   */
  _cancelStaleInflight(requiredKeys) {
    for (const key of [...this._inflight]) {
      if (!requiredKeys.has(key)) {
        this._inflight.delete(key);
        this._pendingUpgrades.delete(key);
      }
    }
    for (const key of [...this._inflightFallback]) {
      if (!requiredKeys.has(key)) {
        this._inflightFallback.delete(key);
      }
    }
  }

  /**
   * @param {Array<{ key: string }>} required
   * @returns {number}
   * @private
   */
  _countUncoveredRequired(required) {
    /** @type {Set<string>} */
    const fallbackKeys = new Set();
    for (const mesh of this._fallbackCellMeshes) {
      const cx = mesh.userData?.streamCellX;
      const cy = mesh.userData?.streamCellY;
      if (Number.isFinite(cx) && Number.isFinite(cy)) fallbackKeys.add(`${cx},${cy}`);
    }

    let n = 0;
    for (const cell of required) {
      const streamEntry = this._cells.get(cell.key);
      if (this._hasTexturedVisibleCell(streamEntry)) continue;
      if (fallbackKeys.has(cell.key)) continue;
      if (this._inflightFallback.has(cell.key)) continue;
      n += 1;
    }
    return n;
  }

  /**
   * @param {number} cellLod
   * @param {number} effectiveLod
   * @param {{ mesh?: import('three').Object3D }|undefined} existing
   * @returns {{ loadLod: number, upgradeToLod: number|null }}
   * @private
   */
  _resolveProgressiveLoadLod(cellLod, effectiveLod, existing) {
    if (existing?.mesh) {
      return { loadLod: cellLod, upgradeToLod: null };
    }
    if (this._coarseBaseReady || this._fallbackMesh || this._fallbackCellMeshes.length > 0) {
      return { loadLod: cellLod, upgradeToLod: null };
    }
    const loadLod = Math.max(cellLod, effectiveLod);
    const upgradeToLod = cellLod < loadLod ? cellLod : null;
    return { loadLod, upgradeToLod };
  }

  /**
   * @private
   */
  _schedulePendingUpgrades(epoch, viewRect, requestedLod, required = null) {
    if (!this._pendingUpgrades.size) return;
    if (this._isPanning && !this._budgetHasHeadroom()) return;
    if (required && this._countUncoveredRequired(required) > 0 && this._isPanning) return;
    const region = this._getSceneRegion();
    const focal = region && this._manifest
      ? resolveFocalImageCell(
        region,
        this._cellSize,
        this._manifest.sourceWidth,
        this._manifest.sourceHeight,
      )
      : null;

    const entries = [...this._pendingUpgrades.entries()].sort((a, b) => {
      if (!focal) return 0;
      const partsA = a[0].split(',');
      const partsB = b[0].split(',');
      if (partsA.length !== 2 || partsB.length !== 2) return 0;
      const ringA = imageCellChebyshevRing(focal.cellX, focal.cellY, Number(partsA[0]), Number(partsA[1]));
      const ringB = imageCellChebyshevRing(focal.cellX, focal.cellY, Number(partsB[0]), Number(partsB[1]));
      if (ringA !== ringB) return ringA - ringB;
      return a[1] - b[1];
    });

    for (const [key, targetLod] of entries) {
      if (!this._activeRequiredKeys.has(key)) {
        this._pendingUpgrades.delete(key);
        continue;
      }
      if (this._inflight.has(key)) continue;
      const parts = key.split(',');
      if (parts.length !== 2) {
        this._pendingUpgrades.delete(key);
        continue;
      }
      const cell = { key, cellX: Number(parts[0]), cellY: Number(parts[1]) };
      const existing = this._cells.get(key);
      if (existing?.mesh && Number(existing.lod) <= targetLod) {
        this._pendingUpgrades.delete(key);
        continue;
      }
      this._pendingUpgrades.delete(key);
      this._inflight.add(key);
      void this._loadCell(cell.cellX, cell.cellY, targetLod, epoch, {
        decodePriority: DECODE_PRIORITY.UPGRADE,
        fastSharpen: true,
      });
    }
  }

  /**
   * Start or continue pyramid loads for cells in the current view.
   * @private
   */
  _scheduleRequiredCellLoads(required, effectiveLod, epoch, viewRect = null, requestedLod = effectiveLod, panStabilize = true) {
    if (!this._isFloorVisible()) return;
    const budget = getTextureBudgetTracker();
    const region = this._getSceneRegion();
    const focal = region && this._manifest
      ? resolveFocalImageCell(
        region,
        this._cellSize,
        this._manifest.sourceWidth,
        this._manifest.sourceHeight,
        viewRect,
      )
      : null;
    const sharpenBacklog = this._hasSharpenBacklog(required, viewRect, requestedLod, focal);
    const uncovered = this._countUncoveredRequired(required);
    /** Cap concurrent LOD-0 GPU uploads on huge scenes (higher when VRAM has headroom). */
    const mp = estimateSceneMegapixels();
    const maxLod0Inflight = mp >= 144
      ? (this._budgetHasHeadroom() ? 3 : 2)
      : 4;
    let lod0Inflight = 0;
    for (const key of this._inflight) {
      const entry = this._cells.get(key);
      const pendingTarget = this._pendingUpgrades.get(key);
      const targetLod = pendingTarget ?? entry?.lod;
      if (Number(targetLod) === 0) lod0Inflight += 1;
    }

    const sorted = [...required].sort((a, b) => {
      const la = viewRect
        ? this._effectiveLodForCell(a, viewRect, requestedLod, focal)
        : effectiveLod;
      const lb = viewRect
        ? this._effectiveLodForCell(b, viewRect, requestedLod, focal)
        : effectiveLod;
      const existingA = this._cells.get(a.key);
      const existingB = this._cells.get(b.key);
      const needA = !this._residentLodAcceptable(
        existingA?.lod ?? 99,
        a,
        viewRect,
        requestedLod,
        panStabilize,
        focal,
      );
      const needB = !this._residentLodAcceptable(
        existingB?.lod ?? 99,
        b,
        viewRect,
        requestedLod,
        panStabilize,
        focal,
      );
      if (needA !== needB) return needA ? -1 : 1;

      const ringA = focal
        ? imageCellChebyshevRing(focal.cellX, focal.cellY, a.cellX, a.cellY)
        : 9999;
      const ringB = focal
        ? imageCellChebyshevRing(focal.cellX, focal.cellY, b.cellX, b.cellY)
        : 9999;
      if (ringA !== ringB) return ringA - ringB;

      const gapA = needA ? Math.max(0, (Number(existingA?.lod) || 99) - la) : 0;
      const gapB = needB ? Math.max(0, (Number(existingB?.lod) || 99) - lb) : 0;
      if (gapA !== gapB) return gapB - gapA;

      if (la !== lb) return la - lb;

      if (!viewRect || !region || !this._manifest) return 0;
      const ba = imageCellToWorldBounds(a.cellX, a.cellY, this._cellSize, this._manifest.sourceWidth, this._manifest.sourceHeight, region);
      const bb = imageCellToWorldBounds(b.cellX, b.cellY, this._cellSize, this._manifest.sourceWidth, this._manifest.sourceHeight, region);
      const cam = getCameraGroundCenter();
      const anchorX = cam?.x ?? (viewRect.minX + viewRect.maxX) * 0.5;
      const anchorY = cam?.y ?? (viewRect.minY + viewRect.maxY) * 0.5;
      const da = (ba.minX + ba.maxX) * 0.5 - anchorX;
      const db = (bb.minX + bb.maxX) * 0.5 - anchorX;
      const dya = (ba.minY + ba.maxY) * 0.5 - anchorY;
      const dyb = (bb.minY + bb.maxY) * 0.5 - anchorY;
      return (da * da + dya * dya) - (db * db + dyb * dyb);
    });

    for (const cell of sorted) {
      let cellLod = viewRect
        ? this._effectiveLodForCell(cell, viewRect, requestedLod, focal)
        : effectiveLod;
      cellLod = this._clampCellLodForBudget(cellLod, cell, focal);
      this._cellLastUsed.set(cell.key, performance.now());
      const existing = this._cells.get(cell.key);
      if (uncovered > 0 && existing?.mesh) {
        const acceptable = this._residentLodAcceptable(
          existing.lod,
          cell,
          viewRect,
          requestedLod,
          panStabilize,
          focal,
        );
        if (acceptable) {
          // Fall through — handled below as already sharp enough.
        } else {
          const ring = this._cellFrustumRing(cell, focal);
          // Keep coverage-first for outer cells; still sharpen the focal ring while panning.
          if (ring > INNER_SHARP_RING_MAX) continue;
        }
      }
      if (sharpenBacklog && !existing?.mesh) {
        const ring = this._cellFrustumRing(cell, focal);
        if (ring > INNER_SHARP_RING_MAX + 1) continue;
      }
      if (existing?.mesh) {
        if (this._residentLodAcceptable(existing.lod, cell, viewRect, requestedLod, panStabilize, focal)) {
          existing.mesh.visible = this._isFloorVisible();
          this._setCellState(cell.key, existing.lod === 0 ? STATE_RESIDENT_HI : STATE_RESIDENT_LO);
          continue;
        }
        existing.mesh.visible = this._isFloorVisible();
        if (this._inflight.has(cell.key)) continue;
        if (this._atInflightCap()) continue;
        const { loadLod, upgradeToLod } = this._resolveProgressiveLoadLod(cellLod, effectiveLod, existing);
        if (loadLod === 0 && lod0Inflight >= maxLod0Inflight) continue;
        if (loadLod === 0) lod0Inflight += 1;
        const decodePriority = this._decodePriorityForCellLoad(existing, upgradeToLod, loadLod);
        this._setCellState(cell.key, STATE_LOADING);
        this._inflight.add(cell.key);
        void this._loadCell(cell.cellX, cell.cellY, loadLod, epoch, {
          upgradeToLod,
          decodePriority,
          fastSharpen: decodePriority === DECODE_PRIORITY.UPGRADE,
        });
        continue;
      }
      if (this._inflight.has(cell.key)) continue;
      if (this._atInflightCap()) continue;
      if (this._cells.size >= this._maxTotalResidentCells()) {
        this.evictCells(budget, 1);
      }
      if (!this._cells.has(cell.key) && this._countVisibleResidents() >= this._maxResidentCells()) {
        this.evictCells(budget, 1);
      }

      const { loadLod, upgradeToLod } = this._resolveProgressiveLoadLod(cellLod, effectiveLod, undefined);
      if (loadLod === 0 && lod0Inflight >= maxLod0Inflight) continue;
      if (loadLod === 0) lod0Inflight += 1;
      this._setCellState(cell.key, STATE_LOADING);
      this._inflight.add(cell.key);
      void this._loadCell(cell.cellX, cell.cellY, loadLod, epoch, {
        upgradeToLod,
        decodePriority: DECODE_PRIORITY.COVERAGE,
      });
    }

    this._schedulePendingUpgrades(epoch, viewRect, requestedLod, required);
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
      this._bus._unregisterStreamingMesh?.(this._cellBusKey(key));
      disposeStreamingMesh(entry?.mesh);
    } catch (_) {}
    this._cellLastUsed.delete(key);
    this._cells.delete(key);
    this._setCellState(key, STATE_CULLED);
  }

  /**
   * Release GPU textures for cells outside the current view frustum.
   * @param {Set<string>} requiredKeys
   * @private
   */
  _releaseOffViewCells(requiredKeys) {
    for (const [key, entry] of [...this._cells.entries()]) {
      if (requiredKeys.has(key)) continue;
      if (this._inflight.has(key)) continue;
      this._disposeCell(key, entry);
    }
  }

  /**
   * Build a coarse tiled fallback from pyramid cells (avoids full-image decode on 12k sources).
   * @param {number} [lod=3]
   * @returns {Promise<boolean>}
   * @private
   */
  async _mountCoarseGridFallback(lod = 3) {
    const region = this._getSceneRegion();
    const manifest = this._manifest;
    if (!region || !manifest || !this._scene) return false;
    const epoch = this._decodeEpoch;
    const sourceWidth = manifest.sourceWidth;
    const sourceHeight = manifest.sourceHeight;
    const cols = manifest.cols;
    const rows = manifest.rows;
    const cellSize = this._cellSize;
    const src = this._src;

    /** @param {import('three').Mesh[]} list @private */
    const disposeBuiltMeshes = (list) => {
      for (const mesh of list) {
        try {
          const fbKey = mesh.userData?.tileId;
          if (fbKey) this._bus._unregisterStreamingMesh?.(fbKey);
          disposeStreamingMesh(mesh);
        } catch (_) {}
      }
    };

    const tasks = [];
    for (let cellY = 0; cellY < rows; cellY += 1) {
      for (let cellX = 0; cellX < cols; cellX += 1) {
        tasks.push({ cellX, cellY });
      }
    }

    const batchSize = estimateSceneMegapixels() >= 144 ? 4 : 6;
    /** @type {import('three').Mesh[]} */
    const built = [];
    for (let i = 0; i < tasks.length; i += batchSize) {
      if (epoch !== this._decodeEpoch) break;
      const batch = tasks.slice(i, i + batchSize);
      const batchMeshes = await Promise.all(batch.map(async ({ cellX, cellY }) => {
        if (epoch !== this._decodeEpoch) return null;
        const tex = await loadPyramidTileTexture(
          src,
          cellX,
          cellY,
          lod,
          cellSize,
          sourceWidth,
          sourceHeight,
          { priority: DECODE_PRIORITY.FALLBACK },
        );
        if (epoch !== this._decodeEpoch) {
          disposeStreamingTexture(tex);
          return null;
        }
        if (!tex) return null;

        adoptPyramidTileTexture(tex);

        const bounds = imageCellToWorldBounds(
          cellX,
          cellY,
          cellSize,
          sourceWidth,
          sourceHeight,
          region,
        );
        const mesh = this._createCellMesh(cellX, cellY, bounds, tex, lod, true);
        mesh.userData.mapShineStreamingFallback = true;
        mesh.userData.streamCellX = cellX;
        mesh.userData.streamCellY = cellY;
        getTextureBudgetTracker().register(
          tex,
          `stream:fallback-cell:${this._key}:${cellX},${cellY}:L${lod}`,
          estimateTextureBytes(tex.image?.width ?? 128, tex.image?.height ?? 128, 'ubyte'),
          { source: 'streamFallback' },
        );
        return mesh;
      }));
      for (const mesh of batchMeshes) {
        if (mesh) built.push(mesh);
      }
    }

    if (epoch !== this._decodeEpoch) {
      disposeBuiltMeshes(built);
      return false;
    }

    const meshes = built;

    if (!meshes.length) return false;

    this._fallbackCellMeshes = meshes;
    this._coarseBaseReady = true;
    return true;
  }

  /**
   * Load coarse fallback tiles only for visible cells that lack stream cover.
   * Avoids monopolizing the decode queue with a full-scene 12×12 preload.
   * @param {Array<{ key: string, cellX: number, cellY: number }>} required
   * @param {number} fallbackLod
   * @param {{ isPanning?: boolean, uncovered?: number }} [options]
   * @private
   */
  _ensureFallbackForRequired(required, fallbackLod = 3, options = {}) {
    if (!this._isFloorVisible()) return;
    const isPanning = options.isPanning === true;
    const region = this._getSceneRegion();
    if (!region || !this._manifest || !this._scene || this._fallbackMesh) return;

    /** @type {Set<string>} */
    const existingKeys = new Set();
    for (const mesh of this._fallbackCellMeshes) {
      const cx = mesh.userData?.streamCellX;
      const cy = mesh.userData?.streamCellY;
      if (Number.isFinite(cx) && Number.isFinite(cy)) existingKeys.add(`${cx},${cy}`);
    }

    const uncovered = Number.isFinite(options.uncovered)
      ? Number(options.uncovered)
      : this._countUncoveredRequired(required);
    const maxPerSync = uncovered > 0
      ? Math.min(16, isPanning ? 12 : 8 + Math.min(uncovered, 8))
      : 3;

    const focal = resolveFocalImageCell(
      region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
    );
    const sorted = isPanning && focal
      ? [...required].sort((a, b) => {
        const ringA = imageCellChebyshevRing(focal.cellX, focal.cellY, a.cellX, a.cellY);
        const ringB = imageCellChebyshevRing(focal.cellX, focal.cellY, b.cellX, b.cellY);
        return ringB - ringA;
      })
      : required;

    const epoch = this._decodeEpoch;
    let queued = 0;

    for (const cell of sorted) {
      if (queued >= maxPerSync) break;
      if (existingKeys.has(cell.key) || this._inflightFallback.has(cell.key)) continue;
      const streamEntry = this._cells.get(cell.key);
      if (this._hasTexturedVisibleCell(streamEntry)) continue;

      queued += 1;
      this._inflightFallback.add(cell.key);
      void this._loadFallbackCell(cell.cellX, cell.cellY, fallbackLod, epoch).finally(() => {
        this._inflightFallback.delete(cell.key);
      });
    }
  }

  /** @private */
  async _loadFallbackCell(cellX, cellY, lod, epoch) {
    const region = this._getSceneRegion();
    const manifest = this._manifest;
    if (!region || !manifest || !this._scene) return;
    const key = `${cellX},${cellY}`;
    try {
      if (epoch !== this._decodeEpoch) return;
      if (!this._activeRequiredKeys.has(key)) return;
      const tex = await loadPyramidTileTexture(
        this._src,
        cellX,
        cellY,
        lod,
        this._cellSize,
        manifest.sourceWidth,
        manifest.sourceHeight,
        { priority: DECODE_PRIORITY.FALLBACK },
      );
      if (epoch !== this._decodeEpoch || !tex) {
        disposeStreamingTexture(tex);
        return;
      }
      if (!this._activeRequiredKeys.has(key)) {
        disposeStreamingTexture(tex);
        return;
      }

      for (let i = 0; i < this._fallbackCellMeshes.length; i += 1) {
        const existing = this._fallbackCellMeshes[i];
        if (existing?.userData?.streamCellX !== cellX || existing?.userData?.streamCellY !== cellY) continue;
        try {
          const fbKey = existing.userData?.tileId;
          if (fbKey) this._bus._unregisterStreamingMesh?.(fbKey);
          disposeStreamingMesh(existing);
        } catch (_) {}
        this._fallbackCellMeshes.splice(i, 1);
        break;
      }

      adoptPyramidTileTexture(tex);

      const bounds = imageCellToWorldBounds(
        cellX,
        cellY,
        this._cellSize,
        manifest.sourceWidth,
        manifest.sourceHeight,
        region,
      );
      const mesh = this._createCellMesh(cellX, cellY, bounds, tex, lod, true);
      mesh.userData.mapShineStreamingFallback = true;
      mesh.userData.streamCellX = cellX;
      mesh.userData.streamCellY = cellY;
      getTextureBudgetTracker().register(
        tex,
        `stream:fallback-cell:${this._key}:${cellX},${cellY}:L${lod}`,
        estimateTextureBytes(tex.image?.width ?? 128, tex.image?.height ?? 128, 'ubyte'),
        { source: 'streamFallback' },
      );
      this._fallbackCellMeshes.push(mesh);
    } catch (err) {
      log.warn('StreamedBackgroundGrid: lazy fallback cell failed', key, err);
    }
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
        const fbKey = mesh.userData?.tileId;
        if (fbKey) this._bus._unregisterStreamingMesh?.(fbKey);
        disposeStreamingMesh(mesh);
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
  async mount(src, fd, floorIndex, key, options = {}) {
    this.dispose();
    this._src = src;
    this._key = key;
    this._floorIndex = floorIndex;
    this._fd = fd;
    this._tileRenderOrder = Number(options.renderOrderBase) || 0;
    this._sceneRegion = null;
    this._decodeEpoch += 1;

    const budget = getTextureBudgetTracker();
    this._cellSize = budget.getRecommendedTileSize();
    this._maxLod = budget.getMaxLodLevel();
    const mp = estimateSceneMegapixels();
    this._maxConcurrent = mp >= 144 ? (this._cellSize <= 1024 ? 3 : 2) : mp > 64 ? 3 : 4;

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
      this._coarseFallbackLod = mp >= 144 ? 4 : 3;
      const gridCells = this._manifest.cols * this._manifest.rows;
      this._lazyCoarseFallback = gridCells > 36;
      if (!this._lazyCoarseFallback) {
        void this._mountCoarseGridFallback(this._coarseFallbackLod).catch((err) => {
          log.warn('StreamedBackgroundGrid: coarse fallback mount failed', src, err);
        });
      }
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
        this._coarseBaseReady = true;
      }
    }

    // First sync may sharpen immediately — do not wait for a camera nudge.
    this._lastViewChangeMs = performance.now() - FOCAL_SHARPEN_IDLE_MS;
    this._syncKey = '';
  }

  /**
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} viewRect
   * @param {number} lod
   * @param {{ sharpenOnZoom?: boolean, isPanning?: boolean }} [options]
   */
  async syncToView(viewRect, lod, options = {}) {
    const region = this._getSceneRegion();
    if (!this._manifest || !viewRect || !region) return;
    if (!this._isFloorVisible()) {
      this.suspendForHiddenFloor();
      return;
    }
    if (!intersectRects(viewRect, region)) {
      this._activeRequiredKeys.clear();
      this._cancelStaleInflight(new Set());
      this._releaseOffViewCells(new Set());
      return;
    }
    this._isPanning = options.isPanning === true;
    if (this._isPanning) this._lastViewChangeMs = performance.now();
    const epoch = this._decodeEpoch;
    const effectiveLod = this._stabilizeLod(lod);
    const budget = getTextureBudgetTracker();
    const usedFrac = budget.getUsedFraction();
    const sharpenReady = this._sharpenPassUnlocked(usedFrac);
    const panStabilize = !options.sharpenOnZoom && !sharpenReady && !this._isPanning;
    const required = getImageCellsForWorldView(
      viewRect,
      region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
    );
    const requiredKeys = new Set(required.map((c) => c.key));
    this._activeRequiredKeys = requiredKeys;
    this._cancelStaleInflight(requiredKeys);
    const syncKey = buildViewSyncKey(effectiveLod, requiredKeys);
    // Any change to the required set or LOD resets the idle timer that gates focal
    // sharpening — skip the very first sync after mount (empty _syncKey).
    if (syncKey !== this._syncKey && this._syncKey !== '') {
      this._lastViewChangeMs = performance.now();
    }
    const focal = resolveFocalImageCell(
      region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
      viewRect,
    );
    const needsSharpen = !this._isPanning && (options.sharpenOnZoom || sharpenReady) && required.some((cell) => {
      const existing = this._cells.get(cell.key);
      if (!existing?.mesh) return false;
      return !this._residentLodAcceptable(existing.lod, cell, viewRect, lod, false, focal);
    });
    const uncovered = this._countUncoveredRequired(required);
    const sharpenBacklog = this._hasSharpenBacklog(required, viewRect, lod, focal);
    if (sharpenBacklog && this._src) {
      reprioritizeDecodeQueueForSharpen(hashSourceKey(this._src));
    }
    const overBudget = usedFrac > 1.0;
    const needsLoad = overBudget
      ? this.hasPendingCellWork(viewRect, lod)
      : required.some((cell) =>
        this._cellNeedsWork(cell, viewRect, lod, { panStabilize }, focal),
      );
    if (overBudget && (needsSharpen || needsLoad)) {
      this.evictCells(budget, 4);
    }
    if (syncKey === this._syncKey && !needsSharpen && !needsLoad) {
      this._applyRequiredCellVisibility(required);
      this._maybeReleaseFallback();
      if (this._lazyCoarseFallback && (uncovered > 0 || !sharpenBacklog)) {
        this._ensureFallbackForRequired(required, this._coarseFallbackLod, {
          isPanning: this._isPanning,
          uncovered,
        });
      }
      this._syncFallbackVisibility(required);
      this._schedulePendingUpgrades(epoch, viewRect, lod, required);
      return;
    }
    this._syncKey = syncKey;

    this._releaseOffViewCells(requiredKeys);

    if (this._lazyCoarseFallback && (uncovered > 0 || !sharpenBacklog)) {
      this._ensureFallbackForRequired(required, this._coarseFallbackLod, {
        isPanning: this._isPanning,
        uncovered,
      });
    }

    this._scheduleRequiredCellLoads(required, effectiveLod, epoch, viewRect, lod, panStabilize);

    this._syncFallbackVisibility(required);
    this._schedulePendingUpgrades(epoch, viewRect, lod, required);
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
   * @param {number} cellX
   * @param {number} cellY
   * @param {number} lod
   * @param {number} epoch
   * @param {{ upgradeToLod?: number|null, decodePriority?: number, fastSharpen?: boolean }} [options]
   * @private
   */
  async _loadCell(cellX, cellY, lod, epoch, options = {}) {
    const key = `${cellX},${cellY}`;
    const region = this._getSceneRegion();
    const upgradeToLod = Number.isFinite(options.upgradeToLod) ? Number(options.upgradeToLod) : null;
    const decodePriority = Number.isFinite(options.decodePriority)
      ? Number(options.decodePriority)
      : DECODE_PRIORITY.STREAM;
    const fastSharpen = options.fastSharpen === true;
    // True once ownership of the inflight key + decoded texture transfers to a
    // governor commit. Until then this method is responsible for cleanup.
    let handedOff = false;
    try {
      if (epoch !== this._decodeEpoch || !region) return;
      if (!this._activeRequiredKeys.has(key)) return;
      const tex = await loadPyramidTileTexture(
        this._src,
        cellX,
        cellY,
        lod,
        this._cellSize,
        this._manifest.sourceWidth,
        this._manifest.sourceHeight,
        { priority: decodePriority, fastSharpen },
      );
      if (epoch !== this._decodeEpoch) {
        disposeStreamingTexture(tex);
        return;
      }
      if (!tex) return;
      if (!this._activeRequiredKeys.has(key)) {
        disposeStreamingTexture(tex);
        return;
      }

      // The decode is done; the GPU upload happens when the mesh is attached and
      // first rendered. Pace that attach through the governor so many decodes
      // completing in one frame don't all upload together and trip a context loss.
      handedOff = true;
      const costMb = estimateTextureBytes(
        tex.image?.width ?? 256,
        tex.image?.height ?? 256,
        'ubyte',
      ) / (1024 * 1024);
      const priority = decodePriority === DECODE_PRIORITY.UPGRADE
        ? GPU_WORK_PRIORITY.UPGRADE
        : GPU_WORK_PRIORITY.COVERAGE;
      getGpuWorkScheduler().enqueue({
        id: `${this._key}:cellcommit:${key}`,
        priority,
        costMb,
        commit: () => this._commitCellLoad(key, cellX, cellY, lod, epoch, tex, upgradeToLod),
        onDrop: () => {
          this._inflight.delete(key);
          disposeStreamingTexture(tex);
        },
      });
    } finally {
      if (!handedOff) this._inflight.delete(key);
    }
  }

  /**
   * Commit a decoded cell texture to the scene (the paced GPU upload step).
   * Runs from the GpuWorkScheduler; re-validates state captured at decode time.
   * @param {string} key
   * @param {number} cellX
   * @param {number} cellY
   * @param {number} lod
   * @param {number} epoch
   * @param {import('three').Texture} tex
   * @param {number|null} upgradeToLod
   * @private
   */
  _commitCellLoad(key, cellX, cellY, lod, epoch, tex, upgradeToLod) {
    /** @type {{ cellX: number, cellY: number, upgradeToLod: number, epoch: number }|null} */
    let scheduleUpgrade = null;
    try {
      const region = this._getSceneRegion();
      if (epoch !== this._decodeEpoch || !region || !this._manifest
        || !this._activeRequiredKeys.has(key)) {
        disposeStreamingTexture(tex);
        return;
      }

      const old = this._cells.get(key);
      if (old?.mesh) {
        this._bus._unregisterStreamingMesh?.(this._cellBusKey(key));
        disposeStreamingMesh(old.mesh);
      }

      adoptPyramidTileTexture(tex);

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

      if (upgradeToLod != null && upgradeToLod < lod) {
        if (this._isPanning) {
          this._pendingUpgrades.set(key, upgradeToLod);
        } else if (this._activeRequiredKeys.has(key)) {
          scheduleUpgrade = { cellX, cellY, upgradeToLod, epoch };
        }
      }
    } finally {
      this._inflight.delete(key);
    }

    if (scheduleUpgrade && this._activeRequiredKeys.has(key) && !this._inflight.has(key)) {
      this._inflight.add(key);
      void this._loadCell(
        scheduleUpgrade.cellX,
        scheduleUpgrade.cellY,
        scheduleUpgrade.upgradeToLod,
        scheduleUpgrade.epoch,
        { decodePriority: DECODE_PRIORITY.UPGRADE, fastSharpen: true },
      );
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
    mesh.renderOrder = streamingCellRenderOrder(this._tileRenderOrder, 0, isFallback);
    mesh.userData = { tileId: busKey, mapShineStreaming: true, mapShineStreamingFallback: isFallback };
    this._scene.add(mesh);
    this._bus._registerStreamingMesh?.(busKey, mesh, mat, floorIndex);
    return mesh;
  }

  /**
   * @private
   */
  _createCellMesh(cellX, cellY, bounds, texture, lod, isFallback = false) {
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
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.scale.set(1, -1, 1);
    const z = GROUND_Z - 1 + this._floorIndex * 0.01 + streamingCellLodZOffset(lod, isFallback);
    mesh.position.set(centerX, centerY, z);
    mesh.renderOrder = streamingCellRenderOrder(this._tileRenderOrder, lod, isFallback);
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
    void refreshGridCellPolicy(this);
    this._decodeEpoch += 1;
    this._servedLod = 99;
    this._syncKey = '';
    this._cellLastUsed.clear();
  }

  /** Abort queued decodes without disposing resident GPU cells (floor transition). */
  pauseDecodeWork() {
    this._decodeEpoch += 1;
    try { getGpuWorkScheduler().cancelByPrefix(`${this._key}:cellcommit:`); } catch (_) {}
    this._inflight?.clear?.();
    this._inflightFallback?.clear?.();
    this._pendingUpgrades?.clear?.();
    this._activeRequiredKeys?.clear?.();
    this._syncKey = '';
  }

  /**
   * Stop all decode work and release GPU cells when this floor is above the
   * visible stack (e.g. switching from floor 1 down to floor 0).
   */
  suspendForHiddenFloor() {
    if (this._isFloorVisible()) return;
    this.pauseDecodeWork();
    for (const [key, entry] of [...this._cells.entries()]) {
      this._disposeCell(key, entry);
    }
    if (this._fallbackMesh) this._fallbackMesh.visible = false;
    this._releaseFallbackCellMeshes();
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
    if (!this._isFloorVisible()) {
      this.suspendForHiddenFloor();
      return;
    }
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
    try { getGpuWorkScheduler().cancelByPrefix(`${this._key}:cellcommit:`); } catch (_) {}
    for (const [cellKey, entry] of this._cells) {
      try {
        this._bus._unregisterStreamingMesh?.(this._cellBusKey(cellKey));
        disposeStreamingMesh(entry?.mesh);
      } catch (_) {}
    }
    this._cells.clear();
    this._cellStates.clear();
    this._inflight.clear();
    this._inflightFallback.clear();
    this._activeRequiredKeys.clear();
    this._pendingUpgrades.clear();
    if (this._fallbackMesh) {
      try {
        this._bus._unregisterStreamingMesh?.(`${this._key}__fallback`);
        disposeStreamingMesh(this._fallbackMesh);
      } catch (_) {}
      this._fallbackMesh = null;
    }
    for (const mesh of this._fallbackCellMeshes) {
      try {
        const fbKey = mesh.userData?.tileId;
        if (fbKey) this._bus._unregisterStreamingMesh?.(fbKey);
        disposeStreamingMesh(mesh);
      } catch (_) {}
    }
    this._fallbackCellMeshes = [];
    this._coarseBaseReady = false;
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
    this._isOverhead = false;
    this._roofShadowCaster = false;
    this._cloudShadowBlockerEnabled = false;
    this._tileRenderOrder = 0;
    this._alpha = 1;
    /** @type {Map<string, { mesh: import('three').Object3D, lod: number }>} */
    this._cells = new Map();
    /** @type {Map<string, import('./streaming-grid.js').StreamingCellState>} */
    this._cellStates = new Map();
    this._cellSize = 1024;
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
    /** @type {Set<string>} */
    this._activeRequiredKeys = new Set();
  }

  /** @private */
  _cancelStaleInflight(requiredKeys) {
    for (const key of [...this._inflight]) {
      if (!requiredKeys.has(key)) {
        this._inflight.delete(key);
      }
    }
  }

  /** @private */
  _maxTotalResidentCells() {
    const mp = estimateSceneMegapixels();
    const cs = this._cellSize || 1024;
    if (mp >= 144) return scaleStreamingResidentCap(6, cs);
    if (mp > 64) return scaleStreamingResidentCap(10, cs);
    return maxTotalResidentCellsForScene(cs);
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
      this._bus._unregisterStreamingMesh?.(`${this._key}:${key}`);
      disposeStreamingMesh(entry?.mesh);
    } catch (_) {}
    this._cellLastUsed.delete(key);
    this._cells.delete(key);
    this._setCellState(key, STATE_CULLED);
  }

  /**
   * Release GPU textures for cells outside the current view frustum.
   * @param {Set<string>} requiredKeys
   * @private
   */
  _releaseOffViewCells(requiredKeys) {
    for (const [key, entry] of [...this._cells.entries()]) {
      if (requiredKeys.has(key)) continue;
      if (this._inflight.has(key)) continue;
      this._disposeCell(key, entry);
    }
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
   * Zoom-native LOD unless severely over the software budget cap.
   * @param {number} lod
   * @returns {number}
   * @private
   */
  _streamingLodTarget(lod) {
    const native = Math.max(0, Math.floor(Number(lod) || 0));
    if (getTextureBudgetTracker().getUsedFraction() <= 1.0) {
      return Math.min(native, this._maxLod);
    }
    return this._effectiveLod(lod);
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
    if (!this._isFloorVisible()) return false;
    if (!this._manifest || !viewRect || !this._region) return false;
    const effectiveLod = this._stabilizeLod(this._streamingLodTarget(lod));
    const required = getImageCellsForWorldView(
      viewRect,
      this._region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
    );
    const requiredKeys = new Set(required.map((c) => c.key));
    if ([...this._inflight].some((k) => requiredKeys.has(k))) return true;
    return required.some((cell) => this._cellNeedsWork(cell, effectiveLod));
  }

  /**
   * @private
   */
  _scheduleRequiredCellLoads(required, effectiveLod, epoch) {
    const budget = getTextureBudgetTracker();
    const focal = this._region && this._manifest
      ? resolveFocalImageCell(
        this._region,
        this._cellSize,
        this._manifest.sourceWidth,
        this._manifest.sourceHeight,
      )
      : null;

    const sorted = [...required].sort((a, b) => {
      const existingA = this._cells.get(a.key);
      const existingB = this._cells.get(b.key);
      const needA = this._cellNeedsWork(a, effectiveLod);
      const needB = this._cellNeedsWork(b, effectiveLod);
      if (needA !== needB) return needA ? -1 : 1;

      const ringA = focal
        ? imageCellChebyshevRing(focal.cellX, focal.cellY, a.cellX, a.cellY)
        : 9999;
      const ringB = focal
        ? imageCellChebyshevRing(focal.cellX, focal.cellY, b.cellX, b.cellY)
        : 9999;
      if (ringA !== ringB) return ringA - ringB;

      const gapA = needA ? Math.max(0, (Number(existingA?.lod) || 99) - effectiveLod) : 0;
      const gapB = needB ? Math.max(0, (Number(existingB?.lod) || 99) - effectiveLod) : 0;
      return gapB - gapA;
    });

    for (const cell of sorted) {
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
    if (this._bus && typeof this._bus._computeEntryVisibleForSlice === 'function') {
      const entry = this._bus._tiles?.get?.(this._key) ?? null;
      if (entry) {
        return this._bus._computeEntryVisibleForSlice(this._key, entry);
      }
      if (this._isOverhead && typeof this._bus._isBusTileOnActiveLevelView === 'function') {
        return this._bus._isBusTileOnActiveLevelView(this._key)
          && !this._bus._suppressTileAlbedoForEditing;
      }
    }
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
    if (!this._isFloorVisible()) {
      this.suspendForHiddenFloor();
      return;
    }
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
   * @param {boolean} [options.isOverhead]
   * @param {boolean} [options.roofShadowCaster]
   * @param {boolean} [options.cloudShadowBlockerEnabled]
   * @param {number} [options.renderOrder]
   * @param {number} [options.alpha]
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
    this._isOverhead = !!options.isOverhead;
    this._roofShadowCaster = !!options.roofShadowCaster;
    this._cloudShadowBlockerEnabled = !!options.cloudShadowBlockerEnabled;
    this._tileRenderOrder = Number(options.renderOrder) || 0;
    this._alpha = typeof options.alpha === 'number' ? options.alpha : 1;
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
    this._maxConcurrent = mp >= 144 ? (this._cellSize <= 1024 ? 3 : 2) : mp > 64 ? 3 : 4;

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
   * @param {{ sharpenOnZoom?: boolean, isPanning?: boolean }} [options]
   */
  async syncToView(viewRect, lod, options = {}) {
    if (!this._manifest || !viewRect || !this._region) return;

    if (!this._isFloorVisible()) {
      this.suspendForHiddenFloor();
      return;
    }

    if (!intersectRects(viewRect, this._region)) {
      this._activeRequiredKeys.clear();
      this._cancelStaleInflight(new Set());
      this._releaseOffViewCells(new Set());
      return;
    }

    const epoch = this._decodeEpoch;
    const effectiveLod = this._stabilizeLod(this._streamingLodTarget(lod));
    const required = getImageCellsForWorldView(
      viewRect,
      this._region,
      this._cellSize,
      this._manifest.sourceWidth,
      this._manifest.sourceHeight,
    );
    const requiredKeys = new Set(required.map((c) => c.key));
    this._activeRequiredKeys = requiredKeys;
    this._cancelStaleInflight(requiredKeys);
    const syncKey = buildViewSyncKey(effectiveLod, requiredKeys);
    const isPanning = options.isPanning === true;
    const needsSharpen = !isPanning && options.sharpenOnZoom && required.some((cell) => {
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

    this._releaseOffViewCells(requiredKeys);

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
    let handedOff = false;
    try {
      if (epoch !== this._decodeEpoch) return;
      if (!this._activeRequiredKeys.has(key)) return;
      const tex = await loadPyramidTileTexture(
        this._src,
        cellX,
        cellY,
        lod,
        this._cellSize,
        this._manifest.sourceWidth,
        this._manifest.sourceHeight,
        { priority: DECODE_PRIORITY.STREAM },
      );
      if (epoch !== this._decodeEpoch || !this._region) {
        disposeStreamingTexture(tex);
        return;
      }
      if (!tex) return;
      if (!this._activeRequiredKeys.has(key)) {
        disposeStreamingTexture(tex);
        return;
      }

      // Pace the GPU upload (mesh attach) through the governor.
      handedOff = true;
      const costMb = estimateTextureBytes(
        tex.image?.width ?? 256,
        tex.image?.height ?? 256,
        'ubyte',
      ) / (1024 * 1024);
      getGpuWorkScheduler().enqueue({
        id: `${this._key}:cellcommit:${key}`,
        priority: GPU_WORK_PRIORITY.COVERAGE,
        costMb,
        commit: () => this._commitCellLoad(key, cellX, cellY, lod, epoch, tex),
        onDrop: () => {
          this._inflight.delete(key);
          disposeStreamingTexture(tex);
        },
      });
    } finally {
      if (!handedOff) this._inflight.delete(key);
    }
  }

  /**
   * Commit a decoded region-cell texture to the scene (paced GPU upload step).
   * @param {string} key
   * @param {number} cellX
   * @param {number} cellY
   * @param {number} lod
   * @param {number} epoch
   * @param {import('three').Texture} tex
   * @private
   */
  _commitCellLoad(key, cellX, cellY, lod, epoch, tex) {
    try {
      if (epoch !== this._decodeEpoch || !this._region || !this._manifest
        || !this._activeRequiredKeys.has(key)) {
        disposeStreamingTexture(tex);
        return;
      }

      const old = this._cells.get(key);
      if (old?.mesh) {
        this._disposeCell(key, old);
      }

      adoptPyramidTileTexture(tex);

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
      opacity: this._alpha,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.scale.set(1, -1, 1);
    mesh.position.set(centerX, centerY, this._z + streamingCellLodZOffset(lod, isFallback));
    mesh.rotation.z = this._rotation;
    mesh.renderOrder = streamingCellRenderOrder(this._tileRenderOrder, lod, isFallback);
    mesh.layers.set(0);
    if (this._roofShadowCaster) {
      mesh.layers.enable(20);
      if (this._cloudShadowBlockerEnabled) {
        mesh.layers.enable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      }
    }
    mesh.userData = {
      tileId: busKey,
      foundryTileId: this._key,
      mapShineBusTile: true,
      mapShineStreaming: true,
      mapShineStreamingFallback: isFallback,
      mapShineStreamingCell: !isFallback,
      isOverhead: this._isOverhead,
      floorIndex: this._floorIndex,
    };
    this._scene.add(mesh);
    this._bus._registerStreamingMesh?.(busKey, mesh, mat, this._floorIndex);
    mesh.visible = this._isFloorVisible();
    return mesh;
  }

  /**
   * Region tile source + pyramid manifest for debug UI (minimap overview).
   * @returns {{ sourceUrl: string, manifest: object|null, cellSize: number, region: object|null }|null}
   */
  getStreamInfo() {
    if (!this._manifest) return null;
    return {
      sourceUrl: this._src,
      manifest: this._manifest,
      cellSize: this._cellSize,
      region: this._region,
    };
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

  /**
   * Apply live tile transform/metadata changes without remounting the pyramid.
   * @param {object} options
   * @param {{ minX: number, minY: number, maxX: number, maxY: number }} [options.region]
   * @param {number} [options.floorIndex]
   * @param {number} [options.z]
   * @param {number} [options.rotation]
   * @param {boolean} [options.isOverhead]
   * @param {boolean} [options.roofShadowCaster]
   * @param {boolean} [options.cloudShadowBlockerEnabled]
   * @param {number} [options.renderOrder]
   * @param {number} [options.alpha]
   * @returns {boolean}
   */
  applyLayoutUpdate(options = {}) {
    const prevRegion = this._region;
    const nextRegion = options.region ?? prevRegion;
    if (!prevRegion || !nextRegion) return false;

    if ('floorIndex' in options) this._floorIndex = Number(options.floorIndex) || 0;
    if ('z' in options) this._z = Number(options.z) || 0;
    if ('rotation' in options) this._rotation = Number(options.rotation) || 0;
    if ('isOverhead' in options) this._isOverhead = !!options.isOverhead;
    if ('roofShadowCaster' in options) this._roofShadowCaster = !!options.roofShadowCaster;
    if ('cloudShadowBlockerEnabled' in options) {
      this._cloudShadowBlockerEnabled = !!options.cloudShadowBlockerEnabled;
    }
    if ('renderOrder' in options) this._tileRenderOrder = Number(options.renderOrder) || 0;
    if ('alpha' in options) this._alpha = typeof options.alpha === 'number' ? options.alpha : 1;

    const prevW = prevRegion.maxX - prevRegion.minX;
    const prevH = prevRegion.maxY - prevRegion.minY;
    const nextW = nextRegion.maxX - nextRegion.minX;
    const nextH = nextRegion.maxY - nextRegion.minY;
    const sizeChanged = Math.abs(prevW - nextW) > 0.001 || Math.abs(prevH - nextH) > 0.001;

    const prevCx = (prevRegion.minX + prevRegion.maxX) / 2;
    const prevCy = (prevRegion.minY + prevRegion.maxY) / 2;
    const nextCx = (nextRegion.minX + nextRegion.maxX) / 2;
    const nextCy = (nextRegion.minY + nextRegion.maxY) / 2;

    this._region = nextRegion;

    if (sizeChanged) {
      this.reloadAllCells();
      this._reshapeFallbackMesh();
    } else {
      const dx = nextCx - prevCx;
      const dy = nextCy - prevCy;
      if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
        for (const entry of this._cells.values()) {
          if (entry?.mesh) {
            entry.mesh.position.x += dx;
            entry.mesh.position.y += dy;
          }
        }
        if (this._fallbackMesh) {
          this._fallbackMesh.position.x += dx;
          this._fallbackMesh.position.y += dy;
        }
      }
    }

    this._applyLayoutToAllMeshes();
    this._syncKey = '';
    return true;
  }

  /** @private */
  _reshapeFallbackMesh() {
    if (!this._fallbackMesh || !this._region) return;
    const THREE = window.THREE;
    if (!THREE) return;

    const w = this._region.maxX - this._region.minX;
    const h = this._region.maxY - this._region.minY;
    const centerX = this._region.minX + w / 2;
    const centerY = this._region.minY + h / 2;

    try { this._fallbackMesh.geometry?.dispose?.(); } catch (_) {}
    this._fallbackMesh.geometry = new THREE.PlaneGeometry(w, h);
    this._fallbackMesh.position.set(centerX, centerY, this._z - 0.001);
    this._applyLayoutToMesh(this._fallbackMesh, true, 0);
  }

  /** @private */
  _applyLayoutToAllMeshes() {
    if (this._fallbackMesh) this._applyLayoutToMesh(this._fallbackMesh, true, 0);
    for (const entry of this._cells.values()) {
      const lod = Number(entry?.lod) || 0;
      if (entry?.mesh) this._applyLayoutToMesh(entry.mesh, false, lod);
    }
  }

  /**
   * @param {import('three').Mesh} mesh
   * @param {boolean} isFallback
   * @param {number} lod
   * @private
   */
  _applyLayoutToMesh(mesh, isFallback, lod = 0) {
    mesh.rotation.z = this._rotation;
    mesh.position.z = this._z + streamingCellLodZOffset(lod, isFallback);
    mesh.renderOrder = streamingCellRenderOrder(this._tileRenderOrder, lod, isFallback);

    if (mesh.material) {
      mesh.material.opacity = this._alpha;
      mesh.material.needsUpdate = true;
    }

    mesh.layers.set(0);
    if (this._roofShadowCaster) {
      mesh.layers.enable(20);
      if (this._cloudShadowBlockerEnabled) {
        mesh.layers.enable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      } else {
        mesh.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
      }
    } else {
      mesh.layers.disable(20);
      mesh.layers.disable(TILE_FEATURE_LAYERS.CLOUD_SHADOW_BLOCKER);
    }

    mesh.userData = mesh.userData || {};
    mesh.userData.isOverhead = this._isOverhead;
    mesh.userData.floorIndex = this._floorIndex;
    mesh.visible = this._isFloorVisible();
  }

  /** Abort queued decodes without disposing resident GPU cells (floor transition). */
  pauseDecodeWork() {
    this._decodeEpoch += 1;
    try { getGpuWorkScheduler().cancelByPrefix(`${this._key}:cellcommit:`); } catch (_) {}
    this._inflight?.clear?.();
    this._activeRequiredKeys?.clear?.();
    this._syncKey = '';
  }

  /** Stop decode work and release cells when this floor is above the visible stack. */
  suspendForHiddenFloor() {
    if (this._isFloorVisible()) return;
    this.pauseDecodeWork();
    for (const [key, entry] of [...this._cells.entries()]) {
      this._disposeCell(key, entry);
    }
    if (this._fallbackMesh) this._fallbackMesh.visible = false;
  }

  /** Drop resident cells for cache/schema reload. */
  reloadAllCells() {
    for (const [key, entry] of [...this._cells.entries()]) {
      try {
        this._bus._unregisterStreamingMesh?.(`${this._key}:${key}`);
        disposeStreamingMesh(entry?.mesh);
      } catch (_) {}
      this._setCellState(key, STATE_CULLED);
    }
    this._cells.clear();
    void refreshGridCellPolicy(this);
    this._decodeEpoch += 1;
    this._servedLod = 99;
    this._syncKey = '';
    this._cellLastUsed.clear();
  }

  dispose() {
    this._decodeEpoch += 1;
    try { getGpuWorkScheduler().cancelByPrefix(`${this._key}:cellcommit:`); } catch (_) {}
    for (const [key, entry] of this._cells) {
      try {
        this._bus._unregisterStreamingMesh?.(`${this._key}:${key}`);
        disposeStreamingMesh(entry?.mesh);
      } catch (_) {}
    }
    this._cells.clear();
    this._cellStates.clear();
    this._inflight.clear();
    this._activeRequiredKeys.clear();
    if (this._fallbackMesh) {
      try {
        this._bus._unregisterStreamingMesh?.(`${this._key}__fallback`);
        disposeStreamingMesh(this._fallbackMesh);
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
