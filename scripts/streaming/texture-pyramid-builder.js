/**
 * @fileoverview Build and load tiled texture pyramids via sub-rect createImageBitmap decode.
 * @module streaming/texture-pyramid-builder
 */

import { createLogger } from '../core/log.js';
import { applyTexturePolicy } from '../assets/texture-policies.js';
import { normalizeTextureUrl, fetchImageBlob, loadImageTexture } from '../assets/image-texture-loader.js';
import { idbGetTileBlob, idbPutTileBlob } from './pyramid-indexed-db.js';
import { lodPixelSize } from './streaming-grid.js';
import { probeImageDimensionsFromBlob, isHugeImageSource } from './probe-image-dimensions.js';

const log = createLogger('TexturePyramidBuilder');

/** Pyramid tile cache schema — bump when cell sizing / decode changes. */
export const PYRAMID_TILE_CACHE_VERSION = 2;

/** Max decoded tile textures kept in RAM (LRU eviction). */
const MAX_TILE_TEXTURE_CACHE = 24;

/** Max source blobs cached in RAM simultaneously. */
const MAX_SOURCE_BLOB_CACHE = 3;

/** In-memory blob cache per source URL. */
const _sourceBlobCache = new Map();

/** In-memory decoded tile texture cache (insertion order = LRU). */
const _tileTextureCache = new Map();

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
  while (_sourceBlobCache.size > MAX_SOURCE_BLOB_CACHE) {
    const oldest = _sourceBlobCache.keys().next().value;
    if (oldest === undefined) break;
    _sourceBlobCache.delete(oldest);
  }
}

/** @private */
function _trimTileTextureCache(exceptKey = null) {
  while (_tileTextureCache.size > MAX_TILE_TEXTURE_CACHE) {
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
 * Release a pyramid tile texture from the in-memory cache (e.g. when a cell is culled).
 * @param {import('three').Texture|null|undefined} tex
 */
export function releasePyramidTileTexture(tex) {
  const key = tex?.userData?.mapShineStreamingTileKey;
  if (!key) return;
  const cached = _tileTextureCache.get(key);
  if (cached === tex) {
    _tileTextureCache.delete(key);
    try { tex.dispose?.(); } catch (_) {}
  }
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
  const cs = Math.max(512, Math.floor(cellSize) || 2048);
  const sw = Math.max(1, Math.floor(sourceWidth) || 1);
  const sh = Math.max(1, Math.floor(sourceHeight) || 1);
  return `v${PYRAMID_TILE_CACHE_VERSION}:${sourceKey}:cs${cs}:${sw}x${sh}:${cellX},${cellY}:L${lod}`;
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
 * @returns {Promise<import('three').Texture|null>}
 */
export async function loadPyramidTileTexture(url, cellX, cellY, lod, cellSize, sourceWidth, sourceHeight) {
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
  const sw = Math.min(cs, Math.max(1, sourceWidth - sx));
  const sh = Math.min(cs, Math.max(1, sourceHeight - sy));
  const outPx = lodPixelSize(cs, lod);

  let blob = await idbGetTileBlob(cacheKey);
  if (!blob) {
    const meta = await fetchSourceImageMeta(url);
    if (!meta) return null;
    try {
      const bitmap = await createImageBitmap(
        meta.blob,
        sx, sy, sw, sh,
        {
          resizeWidth: outPx,
          resizeHeight: Math.max(1, Math.round(outPx * (sh / sw))),
          resizeQuality: 'medium',
          premultiplyAlpha: 'none',
          colorSpaceConversion: 'none',
        },
      );
      blob = await new Promise((resolve) => {
        const cv = document.createElement('canvas');
        cv.width = bitmap.width;
        cv.height = bitmap.height;
        const cx = cv.getContext('2d');
        if (!cx) {
          bitmap.close();
          resolve(null);
          return;
        }
        cx.drawImage(bitmap, 0, 0);
        bitmap.close();
        cv.toBlob((b) => resolve(b), 'image/webp', 0.92);
      });
      if (blob) void idbPutTileBlob(cacheKey, blob);
    } catch (err) {
      log.warn('loadPyramidTileTexture decode failed', cacheKey, err);
      return null;
    }
  }

  if (!blob) return null;

  try {
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const cv = document.createElement('canvas');
    cv.width = bitmap.width;
    cv.height = bitmap.height;
    const cx = cv.getContext('2d');
    if (!cx) {
      bitmap.close();
      return null;
    }
    cx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const texture = new THREE.Texture(cv);
    texture.flipY = false;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    applyTexturePolicy(texture, 'TILE_ALBEDO');
    texture.userData = texture.userData || {};
    texture.userData.mapShineStreamingTileKey = cacheKey;
    texture.userData.mapShineTextureOwned = true;
    texture.needsUpdate = true;
    _tileTextureCache.set(cacheKey, texture);
    _trimTileTextureCache(cacheKey);
    return texture;
  } catch (err) {
    log.warn('loadPyramidTileTexture upload failed', cacheKey, err);
    return null;
  }
}

/**
 * Load a downscaled full-image fallback (never full 12000 native).
 * Returns null for huge sources — use coarse per-cell fallback grid instead.
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
      `loadFallbackTexture: skipping full-image decode for ${meta.width}x${meta.height} — use coarse grid`,
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
    const cv = document.createElement('canvas');
    cv.width = bitmap.width;
    cv.height = bitmap.height;
    const cx = cv.getContext('2d');
    if (!cx) {
      bitmap.close();
      return null;
    }
    cx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const texture = new THREE.Texture(cv);
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
  for (const tex of _tileTextureCache.values()) {
    try { tex.dispose?.(); } catch (_) {}
  }
  _tileTextureCache.clear();
  _sourceBlobCache.clear();
}
