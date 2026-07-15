/**

 * @fileoverview Build and load tiled texture pyramids via worker pool or legacy sub-rect decode.

 * @module streaming/texture-pyramid-builder

 */



import { createLogger } from '../core/log.js';

import { applyTexturePolicy } from '../assets/texture-policies.js';

import { normalizeTextureUrl, fetchImageBlob, loadImageTexture } from '../assets/image-texture-loader.js';

import { idbGetTileBlob, idbPutTileBlob } from './pyramid-indexed-db.js';

import { lodPixelSize } from './streaming-grid.js';

import { probeImageDimensionsFromBlob, isHugeImageSource } from './probe-image-dimensions.js';

import {

  getTileDecodePool,

  disposeTileDecodePool,

  TileDecodePool,

  WORKER_DECODE_SUPPORTED,

} from './tile-decode-pool.js';



const log = createLogger('TexturePyramidBuilder');



/** Pyramid tile cache schema — bump when cell sizing / decode changes. */

export const PYRAMID_TILE_CACHE_VERSION = 2;



/** Max decoded tile textures kept in RAM (LRU eviction). */

let _maxTileTextureCache = 64;



/** Max source blobs cached in RAM simultaneously. */

let _maxSourceBlobCache = 3;



/**
 * @returns {number}
 */
export function getTileTextureCacheLimit() {
  return _maxTileTextureCache;
}



/**
 * @returns {number} Decoded pyramid tile textures currently held in the RAM cache.
 */
export function getTileTextureCacheSize() {
  return _tileTextureCache.size;
}

/**
 * Compare pyramid RAM cache entries against live scene-graph texture references.
 * `alsoOnMesh` > 0 means adoptPyramidTileTexture() was skipped after decode.
 *
 * @param {Set<object>|null|undefined} sceneTextures
 * @returns {{ size: number, limit: number, generation: number, inCacheOnly: number, alsoOnMesh: number, cacheOnlySample: string[] }}
 */
export function auditPyramidTextureCache(sceneTextures = null) {
  let inCacheOnly = 0;
  let alsoOnMesh = 0;
  /** @type {string[]} */
  const cacheOnlySample = [];
  for (const [key, tex] of _tileTextureCache) {
    if (sceneTextures?.has(tex)) {
      alsoOnMesh += 1;
    } else {
      inCacheOnly += 1;
      if (cacheOnlySample.length < 12) cacheOnlySample.push(key);
    }
  }
  return {
    size: _tileTextureCache.size,
    limit: _maxTileTextureCache,
    generation: _cacheGeneration,
    inCacheOnly,
    alsoOnMesh,
    cacheOnlySample,
  };
}



/**
 * @returns {number}
 */
export function getSourceBlobCacheLimit() {
  return _maxSourceBlobCache;
}



/**
 * Apply RAM-profile cache limits from graphics settings.
 * @param {{ tileCache?: number, blobCache?: number }} profile
 */
export function configurePyramidMemoryCaches(profile = {}) {
  const tileCache = Number(profile.tileCache);
  const blobCache = Number(profile.blobCache);
  if (Number.isFinite(tileCache) && tileCache >= 8) {
    _maxTileTextureCache = Math.floor(tileCache);
  }
  if (Number.isFinite(blobCache) && blobCache >= 1) {
    _maxSourceBlobCache = Math.floor(blobCache);
  }
  _trimSourceBlobCache();
  _trimTileTextureCache();
}



/** In-memory blob cache per source URL. */

const _sourceBlobCache = new Map();



/** In-memory decoded tile texture cache (insertion order = LRU). */

const _tileTextureCache = new Map();



/** Decode priority — lower values run before higher (coverage beats sharpen). */

export const DECODE_PRIORITY = {

  COVERAGE: 0,

  FALLBACK: 5,

  UPGRADE: 15,

  STREAM: 30,

  DEFERRED: 45,

  SHARPEN: 15,

  STALE: 999,

};



/** @typedef {{ priority: number, seq: number, run: () => Promise<void> }} DecodeQueueEntry */



/** @type {Map<string, { running: boolean, queue: DecodeQueueEntry[] }>} */

const _sourceDecodeQueue = new Map();



/** Bumped on clearPyramidMemoryCaches — stale in-flight loads must not repopulate the cache. */

let _cacheGeneration = 0;



/** @type {number} */

let _decodeSeq = 0;



/**

 * @param {import('three').Texture} texture

 * @param {string} cacheKey

 * @private

 */

function _finalizeTileTexture(texture, cacheKey) {

  const THREE = window.THREE;

  if (!THREE || !texture) return texture;

  texture.flipY = false;

  texture.wrapS = THREE.ClampToEdgeWrapping;

  texture.wrapT = THREE.ClampToEdgeWrapping;

  applyTexturePolicy(texture, 'TILE_ALBEDO');

  texture.userData = texture.userData || {};

  texture.userData.mapShineStreamingTileKey = cacheKey;

  texture.userData.mapShineTextureOwned = true;

  texture.needsUpdate = true;

  return texture;

}



/**

 * @param {ImageBitmap} bitmap

 * @param {string} cacheKey

 * @param {number} loadGeneration

 * @returns {import('three').Texture|null}

 * @private

 */

function _textureFromBitmap(bitmap, cacheKey, loadGeneration) {

  const THREE = window.THREE;

  if (!THREE || !bitmap) return null;

  if (loadGeneration !== _cacheGeneration) {

    try { bitmap.close?.(); } catch (_) {}

    return null;

  }

  const texture = _finalizeTileTexture(new THREE.Texture(bitmap), cacheKey);

  if (loadGeneration !== _cacheGeneration) {

    try { texture.dispose?.(); } catch (_) {}

    return null;

  }

  _tileTextureCache.set(cacheKey, texture);

  _trimTileTextureCache(cacheKey);

  return texture;

}



/**

 * Persist tile bitmap to IndexedDB without blocking the caller.

 * @param {ImageBitmap} bitmap

 * @param {string} cacheKey

 * @param {boolean} fastSharpen

 * @private

 */

function _persistTileBitmapAsync(bitmap, cacheKey, fastSharpen = false) {

  void (async () => {

    try {

      const cv = document.createElement('canvas');

      cv.width = bitmap.width;

      cv.height = bitmap.height;

      const cx = cv.getContext('2d');

      if (!cx) return;

      cx.drawImage(bitmap, 0, 0);

      const blob = await new Promise((resolve) => {

        cv.toBlob((b) => resolve(b), 'image/webp', fastSharpen ? 0.85 : 0.92);

      });

      if (blob) await idbPutTileBlob(cacheKey, blob);

    } catch (_) {}

  })();

}



/**

 * @param {string} sourceKey

 * @private

 */

function _drainDecodeQueue(sourceKey) {

  const key = sourceKey || '_';

  const state = _sourceDecodeQueue.get(key);

  if (!state || state.running) return;



  while (state.queue.length > 0) {

    const entry = state.queue[0];

    if (entry.priority >= DECODE_PRIORITY.STALE) {

      state.queue.shift();

      entry.run().catch(() => {});

      continue;

    }

    break;

  }



  const entry = state.queue.shift();

  if (!entry) {

    _sourceDecodeQueue.delete(key);

    return;

  }



  state.running = true;

  void entry.run().finally(() => {

    state.running = false;

    _drainDecodeQueue(key);

  });

}



/**

 * Priority-ordered decode queue per source — legacy fallback when workers unavailable.

 * @template T

 * @param {string} sourceKey

 * @param {() => Promise<T>} fn

 * @param {number} [priority=DECODE_PRIORITY.STREAM]

 * @returns {Promise<T>}

 */

export function withSourceDecodeLock(sourceKey, fn, priority = DECODE_PRIORITY.STREAM) {

  const key = sourceKey || '_';

  return new Promise((resolve, reject) => {

    /** @type {DecodeQueueEntry} */

    const entry = {

      priority: Math.max(0, Math.floor(Number(priority) || DECODE_PRIORITY.STREAM)),

      seq: _decodeSeq++,

      run: async () => {

        try {

          resolve(await fn());

        } catch (err) {

          reject(err);

        }

      },

    };



    let state = _sourceDecodeQueue.get(key);

    if (!state) {

      state = { running: false, queue: [] };

      _sourceDecodeQueue.set(key, state);

    }

    state.queue.push(entry);

    state.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);

    _drainDecodeQueue(key);

  });

}



/**

 * When sharpen backlog begins, defer queued coverage/fallback/stream work so upgrades run next.

 * @param {string} sourceKey

 */

export function reprioritizeDecodeQueueForSharpen(sourceKey) {

  const key = sourceKey || '_';

  const state = _sourceDecodeQueue.get(key);

  if (state?.queue?.length) {

    for (const entry of state.queue) {

      if (entry.priority >= DECODE_PRIORITY.STREAM) {

        entry.priority = DECODE_PRIORITY.DEFERRED;

      } else if (entry.priority >= DECODE_PRIORITY.UPGRADE) {

        entry.priority = DECODE_PRIORITY.DEFERRED;

      }

    }

    state.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);

  }

}



/**

 * Crop-decode a blob sub-rect with an isolated slice + retry on transient InvalidStateError.

 * @param {Blob} blob

 * @param {number} sx

 * @param {number} sy

 * @param {number} sw

 * @param {number} sh

 * @param {ImageBitmapOptions} [opts]

 * @returns {Promise<ImageBitmap>}

 */

async function decodeImageBitmapCrop(blob, sx, sy, sw, sh, opts = {}) {

  let lastErr = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {

    try {

      const slice = blob.slice(0, blob.size, blob.type);

      return await createImageBitmap(slice, sx, sy, sw, sh, opts);

    } catch (err) {

      lastErr = err;

      const name = String(err?.name ?? '');

      const retryable = name === 'InvalidStateError' || name === 'EncodingError';

      if (!retryable || attempt >= 2) break;

      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));

    }

  }

  throw lastErr;

}



/**

 * Simple hash for cache keys.

 * @param {string} src

 * @returns {string}

 */

export function hashSourceKey(src) {

  const s = normalizeTextureUrl(src);

  let h = 2166136261;

  for (let i = 0; i < s.length; i += 1) {

    h ^= s.charCodeAt(i);

    h = Math.imul(h, 16777619);

  }

  return (h >>> 0).toString(36);

}



/** @private */

function _trimSourceBlobCache() {

  while (_sourceBlobCache.size > _maxSourceBlobCache) {

    const oldest = _sourceBlobCache.keys().next().value;

    if (oldest === undefined) break;

    _sourceBlobCache.delete(oldest);

  }

}



/** @private */

function _trimTileTextureCache(exceptKey = null) {

  while (_tileTextureCache.size > _maxTileTextureCache) {

    let evictKey = null;

    for (const k of _tileTextureCache.keys()) {

      if (k !== exceptKey) {

        evictKey = k;

        break;

      }

    }

    if (!evictKey) break;

    const tex = _tileTextureCache.get(evictKey);

    _tileTextureCache.delete(evictKey);

    try { tex?.dispose?.(); } catch (_) {}

  }

}



/**

 * Remove a decoded tile from the LRU cache without disposing it — call when a cell

 * mesh takes ownership so cache eviction cannot destroy a live albedo map.

 * @param {import('three').Texture|null|undefined} tex

 */

export function adoptPyramidTileTexture(tex) {

  const key = tex?.userData?.mapShineStreamingTileKey;

  if (!key) return;

  if (_tileTextureCache.get(key) === tex) _tileTextureCache.delete(key);

}



/**

 * Release a pyramid tile texture (cache entry + GPU object).

 * @param {import('three').Texture|null|undefined} tex

 */

export function releasePyramidTileTexture(tex) {

  if (!tex) return;

  adoptPyramidTileTexture(tex);

  try { tex.dispose?.(); } catch (_) {}

}



/**

 * Fetch source image blob (cached). Dimensions come from header probe — never full raster decode.

 * @param {string} url

 * @returns {Promise<{ blob: Blob, width: number, height: number }|null>}

 */

export async function fetchSourceImageMeta(url) {

  const key = normalizeTextureUrl(url);

  if (!key) return null;

  const cached = _sourceBlobCache.get(key);

  if (cached) return cached;



  try {

    const blob = await fetchImageBlob(url);

    if (!blob) {

      log.warn('fetchSourceImageMeta: no blob', key);

      return null;

    }



    let width = 0;

    let height = 0;

    const probed = await probeImageDimensionsFromBlob(blob);

    if (probed) {

      width = probed.width;

      height = probed.height;

    } else {

      log.warn('fetchSourceImageMeta: header probe failed — cannot determine dimensions', key);

      return null;

    }



    if (!(width > 0 && height > 0)) return null;



    const meta = { blob, width, height };

    _sourceBlobCache.set(key, meta);

    _trimSourceBlobCache();

    return meta;

  } catch (err) {

    log.warn('fetchSourceImageMeta failed', key, err);

    return null;

  }

}



/**

 * Build pyramid manifest for a source image.

 *

 * @param {string} url

 * @param {number} cellSize

 * @param {number} maxLod

 * @returns {Promise<object|null>}

 */

export async function buildPyramidManifest(url, cellSize, maxLod = 4) {

  const meta = await fetchSourceImageMeta(url);

  if (!meta) return null;

  const cs = Math.max(512, cellSize);

  const cols = Math.ceil(meta.width / cs);

  const rows = Math.ceil(meta.height / cs);

  return {

    sourceUrl: normalizeTextureUrl(url),

    sourceKey: hashSourceKey(url),

    sourceWidth: meta.width,

    sourceHeight: meta.height,

    cellSize: cs,

    cols,

    rows,

    maxLod,

  };

}



/**

 * Tile cache key — must include cell size and source dimensions so policy

 * changes (4096→2048 cells) never reuse stale cropped tiles from IndexedDB.

 * @param {string} sourceKey

 * @param {number} cellX

 * @param {number} cellY

 * @param {number} lod

 * @param {number} cellSize

 * @param {number} sourceWidth

 * @param {number} sourceHeight

 * @returns {string}

 */

export function tileStorageKey(sourceKey, cellX, cellY, lod, cellSize, sourceWidth, sourceHeight) {

  const cs = Math.max(512, Math.floor(cellSize) || 1024);

  const sw = Math.max(1, Math.floor(sourceWidth) || 1);

  const sh = Math.max(1, Math.floor(sourceHeight) || 1);

  return `v${PYRAMID_TILE_CACHE_VERSION}:${sourceKey}:cs${cs}:${sw}x${sh}:${cellX},${cellY}:L${lod}`;

}



/**

 * @param {string} cacheKey

 * @param {number} loadGeneration

 * @returns {Promise<import('three').Texture|null>}

 * @private

 */

async function _loadTextureFromIdb(cacheKey, loadGeneration) {

  const blob = await idbGetTileBlob(cacheKey);

  if (!blob) return null;

  try {

    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });

    return _textureFromBitmap(bitmap, cacheKey, loadGeneration);

  } catch (err) {

    log.debug('IDB tile decode failed', cacheKey, err);

    return null;

  }

}



/**

 * Legacy main-thread decode path (workers unavailable).

 * @private

 */

async function _legacyDecodeTile(url, cellX, cellY, lod, cellSize, sourceWidth, sourceHeight, cacheKey, loadGeneration, fastSharpen) {

  const sourceKey = hashSourceKey(url);

  const meta = await fetchSourceImageMeta(url);

  if (!meta) return null;



  const cs = Math.max(512, cellSize);

  const sx = cellX * cs;

  const sy = cellY * cs;

  const sw = Math.min(cs, sourceWidth - sx);

  const sh = Math.min(cs, sourceHeight - sy);

  const outPx = lodPixelSize(cs, lod);



  const bitmap = await decodeImageBitmapCrop(

    meta.blob,

    sx, sy, sw, sh,

    {

      resizeWidth: outPx,

      resizeHeight: Math.max(1, Math.round(outPx * (sh / sw))),

      resizeQuality: fastSharpen ? 'low' : 'medium',

      premultiplyAlpha: 'none',

      colorSpaceConversion: 'none',

    },

  );



  _persistTileBitmapAsync(bitmap, cacheKey, fastSharpen);

  return _textureFromBitmap(bitmap, cacheKey, loadGeneration);

}



/**

 * Decode a cropped tile region to THREE.Texture (straight-alpha path).

 *

 * @param {string} url

 * @param {number} cellX

 * @param {number} cellY

 * @param {number} lod

 * @param {number} cellSize

 * @param {number} sourceWidth

 * @param {number} sourceHeight

 * @param {{ priority?: number, fastSharpen?: boolean }} [options]

 * @returns {Promise<import('three').Texture|null>}

 */

export async function loadPyramidTileTexture(url, cellX, cellY, lod, cellSize, sourceWidth, sourceHeight, options = {}) {

  const THREE = window.THREE;

  if (!THREE) return null;



  const sourceKey = hashSourceKey(url);

  const cacheKey = tileStorageKey(sourceKey, cellX, cellY, lod, cellSize, sourceWidth, sourceHeight);

  const mem = _tileTextureCache.get(cacheKey);

  if (mem) {

    _tileTextureCache.delete(cacheKey);

    _tileTextureCache.set(cacheKey, mem);

    return mem;

  }



  const cs = Math.max(512, cellSize);

  const sx = cellX * cs;

  const sy = cellY * cs;

  if (sx >= sourceWidth || sy >= sourceHeight) return null;

  const sw = Math.min(cs, sourceWidth - sx);

  const sh = Math.min(cs, sourceHeight - sy);

  if (!(sw > 0 && sh > 0)) return null;



  const loadGeneration = _cacheGeneration;

  const priority = Number(options?.priority);

  const decodePriority = Number.isFinite(priority) ? priority : DECODE_PRIORITY.STREAM;

  const fastSharpen = options?.fastSharpen === true

    || decodePriority === DECODE_PRIORITY.UPGRADE

    || decodePriority === DECODE_PRIORITY.SHARPEN;



  const idbTex = await _loadTextureFromIdb(cacheKey, loadGeneration);

  if (idbTex) return idbTex;



  const pool = getTileDecodePool();

  if (WORKER_DECODE_SUPPORTED && pool.enabled) {

    const meta = await fetchSourceImageMeta(url);

    if (!meta) return null;

    try {

      const bitmap = await pool.requestTileBitmap({

        url,

        sourceKey,

        cellX,

        cellY,

        lod,

        cellSize: cs,

        sourceWidth,

        sourceHeight,

        priority: decodePriority,

        fastSharpen,

        blob: meta.blob,

      });

      if (bitmap && loadGeneration === _cacheGeneration) {

        return _textureFromBitmap(bitmap, cacheKey, loadGeneration);

      }

      try { bitmap?.close?.(); } catch (_) {}

    } catch (err) {

      log.debug('worker tile decode failed, falling back', cacheKey, err);

    }

  }



  return withSourceDecodeLock(sourceKey, async () => {

    const memLock = _tileTextureCache.get(cacheKey);

    if (memLock) {

      _tileTextureCache.delete(cacheKey);

      _tileTextureCache.set(cacheKey, memLock);

      return memLock;

    }



    const idbAgain = await _loadTextureFromIdb(cacheKey, loadGeneration);

    if (idbAgain) return idbAgain;



    try {

      return await _legacyDecodeTile(

        url, cellX, cellY, lod, cs, sourceWidth, sourceHeight,

        cacheKey, loadGeneration, fastSharpen,

      );

    } catch (err) {

      log.warn('loadPyramidTileTexture decode failed', cacheKey, err);

      return null;

    }

  }, decodePriority);

}



/**

 * Warm the full pyramid off-thread (coarse-first when using default order).

 *

 * @param {object} manifest

 * @param {{ coarseLod?: number, fastSharpen?: boolean }} [options]

 * @returns {Promise<void>}

 */

export async function warmPyramidForManifest(manifest, options = {}) {

  if (!manifest?.sourceKey || !manifest.sourceUrl) return;

  const pool = getTileDecodePool();

  if (!pool.enabled) return;



  const meta = await fetchSourceImageMeta(manifest.sourceUrl);

  if (!meta) return;



  const coarseLod = options.coarseLod ?? manifest.maxLod ?? 4;

  const tiles = TileDecodePool.buildCoarseWarmOrder(manifest, coarseLod);

  await pool.warmPyramidToIdb(

    { ...manifest, sourceKey: manifest.sourceKey, sourceUrl: manifest.sourceUrl },

    tiles,

    { blob: meta.blob, fastSharpen: options.fastSharpen === true, releaseSourceAfter: true },

  );

}



/**

 * @param {string} sourceKey

 * @returns {{ done: number, total: number, fraction: number }|null}

 */

export function getPyramidBakeProgress(sourceKey) {

  return getTileDecodePool().getBakeProgress(sourceKey) ?? null;

}



/**

 * @returns {ReturnType<import('./tile-decode-pool.js').TileDecodePool['getStats']>}

 */

export function getTileDecodePoolStats() {

  return getTileDecodePool().getStats();

}



/**

 * Load a downscaled full-image fallback (never full 12000 native).

 * For huge sources, returns null — use coarse per-cell pyramid base instead.

 *

 * @param {string} url

 * @param {number} maxSize

 * @returns {Promise<import('three').Texture|null>}

 */

export async function loadFallbackTexture(url, maxSize = 2048) {

  const THREE = window.THREE;

  if (!THREE) return null;

  const meta = await fetchSourceImageMeta(url);

  if (!meta) {

    try {

      return await loadImageTexture(url, {

        role: 'ALBEDO',

        maxSize,

        premultiplyAlpha: 'none',

      });

    } catch (err) {

      log.warn('loadFallbackTexture: image-texture-loader fallback failed', url, err);

      return null;

    }

  }



  if (isHugeImageSource(meta.width, meta.height, maxSize * 2)) {

    log.debug(

      `loadFallbackTexture: huge source ${meta.width}x${meta.height} — use coarse pyramid base`,

    );

    return null;

  }



  const scale = maxSize / Math.max(meta.width, meta.height, 1);

  const newW = Math.max(1, Math.round(meta.width * Math.min(1, scale)));

  const newH = Math.max(1, Math.round(meta.height * Math.min(1, scale)));



  try {

    const bitmap = await createImageBitmap(meta.blob, {

      resizeWidth: newW,

      resizeHeight: newH,

      resizeQuality: 'medium',

      premultiplyAlpha: 'none',

      colorSpaceConversion: 'none',

    });



    const texture = new THREE.Texture(bitmap);

    texture.flipY = false;

    texture.wrapS = THREE.ClampToEdgeWrapping;

    texture.wrapT = THREE.ClampToEdgeWrapping;

    applyTexturePolicy(texture, 'TILE_ALBEDO');

    texture.userData = texture.userData || {};

    texture.userData.mapShineStreamingFallback = true;

    texture.userData.mapShineTextureOwned = true;

    texture.needsUpdate = true;

    return texture;

  } catch (err) {

    log.warn('loadFallbackTexture failed', url, err);

    return null;

  }

}



/**

 * Clear in-memory pyramid caches (scene teardown).

 */

export function clearPyramidMemoryCaches() {

  _cacheGeneration += 1;

  for (const tex of _tileTextureCache.values()) {

    try { tex.dispose?.(); } catch (_) {}

  }

  _tileTextureCache.clear();

  _sourceBlobCache.clear();

  _sourceDecodeQueue.clear();

  disposeTileDecodePool();

}



export { WORKER_DECODE_SUPPORTED };

