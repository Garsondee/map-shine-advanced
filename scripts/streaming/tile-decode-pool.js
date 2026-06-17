/**
 * @fileoverview Parallel tile decode worker pool for pyramid streaming.
 * @module streaming/tile-decode-pool
 */

import { createLogger } from '../core/log.js';
import { idbGetTileBlob } from './pyramid-indexed-db.js';
import { tileStorageKey } from './texture-pyramid-builder.js';
import { lodPixelSize } from './streaming-grid.js';
import { estimateSceneMegapixels } from './texture-budget-policy.js';
import { getTextureBudgetTracker } from '../assets/TextureBudgetTracker.js';

const log = createLogger('TileDecodePool');

/** Base max tile bitmaps in flight to main thread (GPU upload throttle). */
const BASE_MAX_GPU_BITMAP_INFLIGHT = 3;

/** @typedef {{ id: number, priority: number, seq: number, msg: object, resolve: Function, reject: Function }} PendingRequest */

/** Workers available when OffscreenCanvas + module workers are supported. */
export const WORKER_DECODE_SUPPORTED = typeof Worker !== 'undefined'
  && typeof OffscreenCanvas !== 'undefined'
  && typeof createImageBitmap === 'function';

/** @type {TileDecodePool|null} */
let _pool = null;

/**
 * @returns {number}
 */
export function resolveWorkerPoolSize() {
  const cores = Number(navigator?.hardwareConcurrency) || 2;
  const mem = Number(navigator?.deviceMemory) || 4;
  const mp = estimateSceneMegapixels();
  if (mem <= 2) return 1;
  if (mp >= 130 || mem <= 4) return 1;
  if (mem <= 8) return Math.min(2, cores);
  return Math.min(3, Math.max(2, Math.floor(cores / 2)));
}

export class TileDecodePool {
  constructor(size = resolveWorkerPoolSize()) {
    /** @type {number} */
    this.poolSize = Math.max(1, size);
    /** @type {Worker[]} */
    this._workers = [];
    /** @type {Map<number, { resolve: Function, reject: Function, cacheKey?: string }>} */
    this._pending = new Map();
    /** @type {number} */
    this._nextId = 1;
    /** @type {number} */
    this._seq = 0;
    /** @type {PendingRequest[]} */
    this._queue = [];
    /** @type {number[]} */
    this._workerBusy = [];
    /** @type {Map<string, number>} sourceKey -> worker index affinity */
    this._sourceAffinity = new Map();
    /** @type {Map<string, { done: number, total: number }>} */
    this._bakeProgress = new Map();
    /** @type {Map<string, Promise<void>>} */
    this._sourceReady = new Map();
    /** @type {number} */
    this.activeRequests = 0;
    /** @type {number} */
    this.completedRequests = 0;
    /** @type {boolean} */
    this.enabled = WORKER_DECODE_SUPPORTED;
    /** @type {number} GPU-bound bitmap transfers in flight to main thread. */
    this._gpuBitmapInflight = 0;

    if (!this.enabled) return;

    for (let i = 0; i < this.poolSize; i += 1) {
      try {
        const worker = new Worker(
          new URL('./tile-decode-worker.js', import.meta.url),
          { type: 'module' },
        );
        worker.addEventListener('message', (ev) => this._onWorkerMessage(i, ev.data));
        worker.addEventListener('error', (err) => {
          log.warn('TileDecodePool worker error', i, err);
        });
        this._workers.push(worker);
        this._workerBusy.push(0);
      } catch (err) {
        log.warn('TileDecodePool: failed to spawn worker', i, err);
        this.enabled = false;
        break;
      }
    }
  }

  /**
   * @returns {{ enabled: boolean, poolSize: number, queueDepth: number, activeRequests: number, bakeProgress: Map<string, { done: number, total: number }> }}
   */
  getStats() {
    return {
      enabled: this.enabled,
      poolSize: this._workers.length,
      queueDepth: this._queue.length,
      activeRequests: this.activeRequests,
      completedRequests: this.completedRequests,
      bakeProgress: new Map(this._bakeProgress),
    };
  }

  /**
   * @param {string} sourceKey
   * @returns {{ done: number, total: number, fraction: number }|null}
   */
  getBakeProgress(sourceKey) {
    const p = this._bakeProgress.get(sourceKey);
    if (!p || !(p.total > 0)) return null;
    return {
      done: p.done,
      total: p.total,
      fraction: Math.min(1, p.done / p.total),
    };
  }

  /**
   * @param {string} sourceKey
   * @param {Blob} blob
   * @param {number} width
   * @param {number} height
   * @returns {Promise<void>}
   */
  async ensureSource(sourceKey, blob, width, height) {
    if (!this.enabled || !sourceKey || !blob) return;
    const existing = this._sourceReady.get(sourceKey);
    if (existing) {
      await existing;
      return;
    }

    const workerIdx = this._pickWorkerForSource(sourceKey);
    const promise = this._post(workerIdx, {
      type: 'ensure-source',
      sourceKey,
      blob,
      width,
      height,
    }).then(() => {});
    this._sourceReady.set(sourceKey, promise);
    try {
      await promise;
    } catch (err) {
      this._sourceReady.delete(sourceKey);
      throw err;
    }
  }

  /**
   * @param {object} params
   * @returns {Promise<ImageBitmap|null>}
   */
  async requestTileBitmap(params) {
    const {
      url,
      sourceKey,
      cellX,
      cellY,
      lod,
      cellSize,
      sourceWidth,
      sourceHeight,
      priority = 30,
      fastSharpen = false,
      blob = null,
    } = params;

    const cacheKey = tileStorageKey(sourceKey, cellX, cellY, lod, cellSize, sourceWidth, sourceHeight);

    if (!this.enabled) return null;

    try {
      const cached = await idbGetTileBlob(cacheKey);
      if (cached) {
        return await createImageBitmap(cached, {
          premultiplyAlpha: 'none',
          colorSpaceConversion: 'none',
        });
      }
    } catch (_) {}

    if (blob) {
      try {
        await this.ensureSource(sourceKey, blob, sourceWidth, sourceHeight);
      } catch (err) {
        log.warn('ensureSource failed', sourceKey, err);
        return null;
      }
    }

    const workerIdx = this._pickWorkerForSource(sourceKey);
    try {
      const result = await this._enqueue(workerIdx, {
        type: 'request-tile',
        sourceKey,
        cacheKey,
        cellX,
        cellY,
        lod,
        cellSize,
        sourceWidth,
        sourceHeight,
        fastSharpen,
        blob,
        url,
      }, priority);
      return result ?? null;
    } catch (err) {
      log.debug('requestTileBitmap failed', cacheKey, err);
      return null;
    }
  }

  /**
   * Warm coarse tiles into IndexedDB only — no ImageBitmap transfer to main thread.
   *
   * @param {object} manifest
   * @param {Array<{ cellX: number, cellY: number, lod: number, priority?: number }>} tiles
   * @param {{ blob?: Blob, fastSharpen?: boolean, releaseSourceAfter?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async warmPyramidToIdb(manifest, tiles, options = {}) {
    if (!this.enabled || !manifest?.sourceKey || !tiles?.length) return;

    const { sourceKey, sourceWidth, sourceHeight, cellSize, sourceUrl } = manifest;
    const blob = options.blob ?? null;
    if (blob) {
      await this.ensureSource(sourceKey, blob, sourceWidth, sourceHeight);
    }

    this._bakeProgress.set(sourceKey, { done: 0, total: tiles.length });
    const workerIdx = this._pickWorkerForSource(sourceKey);
    void this._post(workerIdx, {
      type: 'set-bake-total',
      sourceKey,
      done: 0,
      total: tiles.length,
    }).catch(() => {});

    const sorted = [...tiles].sort((a, b) => {
      const pa = Number(a.priority) || 30;
      const pb = Number(b.priority) || 30;
      if (pa !== pb) return pa - pb;
      return (a.lod ?? 0) - (b.lod ?? 0);
    });

    for (const tile of sorted) {
      try {
        await this._enqueueIdbOnly(workerIdx, {
          type: 'bake-tile-idb',
          sourceKey,
          cacheKey: tileStorageKey(
            sourceKey, tile.cellX, tile.cellY, tile.lod,
            cellSize, sourceWidth, sourceHeight,
          ),
          cellX: tile.cellX,
          cellY: tile.cellY,
          lod: tile.lod,
          cellSize,
          sourceWidth,
          sourceHeight,
          fastSharpen: options.fastSharpen === true,
          blob,
          url: sourceUrl,
        }, tile.priority ?? 45);
      } catch (_) {}
    }

    if (options.releaseSourceAfter !== false) {
      this.releaseSource(sourceKey);
    }
  }

  /**
   * @deprecated Prefer warmPyramidToIdb for background warming.
   * @param {object} manifest
   * @param {Array<{ cellX: number, cellY: number, lod: number, priority?: number }>} tiles
   * @param {{ blob?: Blob, fastSharpen?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async warmPyramid(manifest, tiles, options = {}) {
    await this.warmPyramidToIdb(manifest, tiles, options);
  }

  /**
   * Build coarse-first warm order for a full manifest.
   *
   * @param {object} manifest
   * @param {number} [coarseLod]
   * @returns {Array<{ cellX: number, cellY: number, lod: number, priority: number }>}
   */
  static buildWarmOrder(manifest, coarseLod = null) {
    return TileDecodePool.buildCoarseWarmOrder(manifest, coarseLod);
  }

  /**
   * Coarse LOD tiles only — safe for idle IDB warming without GPU pressure.
   *
   * @param {object} manifest
   * @param {number} [coarseLod]
   * @returns {Array<{ cellX: number, cellY: number, lod: number, priority: number }>}
   */
  static buildCoarseWarmOrder(manifest, coarseLod = null) {
    if (!manifest) return [];
    const { cols, rows, maxLod } = manifest;
    const lod = coarseLod != null ? coarseLod : Math.max(0, Number(maxLod) || 4);
    /** @type {Array<{ cellX: number, cellY: number, lod: number, priority: number }>} */
    const out = [];
    for (let cy = 0; cy < rows; cy += 1) {
      for (let cx = 0; cx < cols; cx += 1) {
        out.push({ cellX: cx, cellY: cy, lod, priority: 0 });
      }
    }
    return out;
  }

  /**
   * Full pyramid warm order (all LODs) — use sparingly; prefer buildCoarseWarmOrder.
   * @param {object} manifest
   * @param {number} [coarseLod]
   * @returns {Array<{ cellX: number, cellY: number, lod: number, priority: number }>}
   */
  static buildFullWarmOrder(manifest, coarseLod = null) {
    if (!manifest) return [];
    const { cols, rows, maxLod, cellSize } = manifest;
    const maxL = Math.max(0, Number(maxLod) || 4);
    const coarse = coarseLod != null ? coarseLod : maxL;
    /** @type {Array<{ cellX: number, cellY: number, lod: number, priority: number }>} */
    const out = [];

    for (let lod = maxL; lod >= 0; lod -= 1) {
      const priority = lod >= coarse ? 0 : 10 + lod;
      for (let cy = 0; cy < rows; cy += 1) {
        for (let cx = 0; cx < cols; cx += 1) {
          out.push({ cellX: cx, cellY: cy, lod, priority });
        }
      }
    }
    return out;
  }

  /**
   * @param {string} sourceKey
   */
  releaseSource(sourceKey) {
    if (!this.enabled || !sourceKey) return;
    this._sourceReady.delete(sourceKey);
    this._sourceAffinity.delete(sourceKey);
    this._bakeProgress.delete(sourceKey);
    const workerIdx = this._pickWorkerForSource(sourceKey);
    void this._post(workerIdx, { type: 'release-source', sourceKey }).catch(() => {});
  }

  dispose() {
    for (const worker of this._workers) {
      try { worker.terminate(); } catch (_) {}
    }
    this._workers = [];
    this._workerBusy = [];
    this._queue = [];
    this._pending.clear();
    this._sourceReady.clear();
    this._sourceAffinity.clear();
    this._bakeProgress.clear();
    this.enabled = false;
  }

  /**
   * @param {string} sourceKey
   * @returns {number}
   * @private
   */
  _pickWorkerForSource(sourceKey) {
    const aff = this._sourceAffinity.get(sourceKey);
    if (aff != null && aff < this._workers.length) return aff;

    let best = 0;
    let minBusy = Infinity;
    for (let i = 0; i < this._workers.length; i += 1) {
      if (this._workerBusy[i] < minBusy) {
        minBusy = this._workerBusy[i];
        best = i;
      }
    }
    this._sourceAffinity.set(sourceKey, best);
    return best;
  }

  /**
   * @param {number} workerIdx
   * @param {object} msg
   * @param {number} [priority=30]
   * @returns {Promise<ImageBitmap|null>}
   * @private
   */
  _enqueue(workerIdx, msg, priority = 30) {
    return new Promise((resolve, reject) => {
      /** @type {PendingRequest} */
      const entry = {
        id: this._nextId++,
        priority: Math.max(0, Math.floor(Number(priority) || 30)),
        seq: this._seq++,
        msg: { ...msg, id: this._nextId - 1 },
        resolve,
        reject,
        gpuBound: msg.type === 'request-tile',
      };
      entry.msg.id = entry.id;
      this._queue.push(entry);
      this._queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this._drainQueue();
    });
  }

  /**
   * @param {number} workerIdx
   * @param {object} msg
   * @param {number} [priority=45]
   * @returns {Promise<void>}
   * @private
   */
  _enqueueIdbOnly(workerIdx, msg, priority = 45) {
    return new Promise((resolve, reject) => {
      const entry = {
        id: this._nextId++,
        priority: Math.max(0, Math.floor(Number(priority) || 45)),
        seq: this._seq++,
        msg: { ...msg, id: this._nextId - 1 },
        resolve,
        reject,
        gpuBound: false,
      };
      entry.msg.id = entry.id;
      this._queue.push(entry);
      this._queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this._drainQueue();
    });
  }

  /** @private */
  _maxGpuBitmapInflight() {
    const used = getTextureBudgetTracker().getUsedFraction();
    if (used > 0.92) return BASE_MAX_GPU_BITMAP_INFLIGHT;
    if (used <= 0.55) return BASE_MAX_GPU_BITMAP_INFLIGHT + 2;
    return BASE_MAX_GPU_BITMAP_INFLIGHT + 1;
  }

  /** @private */
  _canDispatchGpu() {
    return this._gpuBitmapInflight < this._maxGpuBitmapInflight();
  }

  /** @private */
  _drainQueue() {
    for (let i = 0; i < this._workers.length; i += 1) {
      if (this._workerBusy[i]) continue;
      const idx = this._queue.findIndex((e) => {
        if (e.gpuBound && !this._canDispatchGpu()) return false;
        const sk = e.msg.sourceKey;
        const aff = this._sourceAffinity.get(sk);
        return aff == null || aff === i;
      });
      if (idx < 0) {
        if (!this._canDispatchGpu()) break;
        const fallback = this._queue.find((e) => !e.gpuBound);
        if (!fallback) break;
        const fbIdx = this._queue.indexOf(fallback);
        const [entry] = this._queue.splice(fbIdx, 1);
        this._dispatch(i, entry);
        continue;
      }
      const [entry] = this._queue.splice(idx, 1);
      this._dispatch(i, entry);
    }
  }

  /**
   * @param {number} workerIdx
   * @param {PendingRequest} entry
   * @private
   */
  _dispatch(workerIdx, entry) {
    this._workerBusy[workerIdx] = 1;
    this.activeRequests += 1;
    if (entry.gpuBound) this._gpuBitmapInflight += 1;
    this._pending.set(entry.id, {
      resolve: entry.resolve,
      reject: entry.reject,
      cacheKey: entry.msg.cacheKey,
      gpuBound: entry.gpuBound === true,
    });
    try {
      this._workers[workerIdx].postMessage(entry.msg);
    } catch (err) {
      this._workerBusy[workerIdx] = 0;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (entry.gpuBound) {
        this._gpuBitmapInflight = Math.max(0, this._gpuBitmapInflight - 1);
      }
      this._pending.delete(entry.id);
      entry.reject(err);
      this._drainQueue();
    }
  }

  /**
   * @param {number} workerIdx
   * @param {object} msg
   * @returns {Promise<void>}
   * @private
   */
  _post(workerIdx, msg) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      try {
        this._workers[workerIdx].postMessage({ ...msg, id });
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /**
   * @param {number} workerIdx
   * @param {object} data
   * @private
   */
  _onWorkerMessage(workerIdx, data) {
    const type = data?.type;
    if (type === 'worker-ready') return;

    if (type === 'bake-progress' && data.sourceKey) {
      this._bakeProgress.set(data.sourceKey, {
        done: Number(data.done) || 0,
        total: Number(data.total) || 0,
      });
      return;
    }

    const id = data?.id;
    if (id == null) return;

    const pending = this._pending.get(id);
    if (!pending) return;

    if (type === 'tile-ready') {
      this._pending.delete(id);
      this._workerBusy[workerIdx] = 0;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (pending.gpuBound) {
        this._gpuBitmapInflight = Math.max(0, this._gpuBitmapInflight - 1);
      }
      this.completedRequests += 1;
      pending.resolve(data.bitmap ?? null);
      this._drainQueue();
      return;
    }

    if (type === 'tile-idb-done') {
      this._pending.delete(id);
      this._workerBusy[workerIdx] = 0;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      pending.resolve(undefined);
      this._drainQueue();
      return;
    }

    if (type === 'tile-error' || type === 'error') {
      this._pending.delete(id);
      this._workerBusy[workerIdx] = 0;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (pending.gpuBound) {
        this._gpuBitmapInflight = Math.max(0, this._gpuBitmapInflight - 1);
      }
      pending.reject(new Error(data.message ?? 'tile decode failed'));
      this._drainQueue();
      return;
    }

    if (type === 'ensure-source-done' || type === 'source-ready' || type === 'source-released') {
      this._pending.delete(id);
      this._workerBusy[workerIdx] = 0;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      pending.resolve(undefined);
      this._drainQueue();
    }
  }
}

/** @returns {TileDecodePool} */
export function getTileDecodePool() {
  if (!_pool) _pool = new TileDecodePool();
  return _pool;
}

/** Reset pool (scene teardown). */
export function disposeTileDecodePool() {
  if (_pool) {
    _pool.dispose();
    _pool = null;
  }
}

/**
 * Build warm tile list for visible cells at a given LOD.
 *
 * @param {object} manifest
 * @param {Array<{ cellX: number, cellY: number }>} cells
 * @param {number} lod
 * @param {number} [priority=15]
 * @returns {Array<{ cellX: number, cellY: number, lod: number, priority: number }>}
 */
export function buildVisibleWarmTiles(manifest, cells, lod, priority = 15) {
  if (!manifest || !cells?.length) return [];
  return cells.map((c) => ({
    cellX: c.cellX,
    cellY: c.cellY,
    lod,
    priority,
  }));
}
