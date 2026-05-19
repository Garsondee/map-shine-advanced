/**
 * @fileoverview Off-thread image decode → THREE.Texture with role-based mipmap policy.
 * @module assets/image-texture-loader
 */

import { createLogger } from '../core/log.js';
import { debugLoadingProfiler } from '../core/debug-loading-profiler.js';
import { applyTexturePolicy } from './texture-policies.js';

const log = createLogger('ImageTextureLoader');

const _hasImageBitmap = typeof createImageBitmap === 'function';

/** Default max dimension for low-frequency data masks */
export const MASK_MAX_SIZE = 4096;

/** Max dimension for high-frequency visual masks (specular, normal, etc.) */
export const VISUAL_MASK_MAX_SIZE = 8192;

/** @type {Map<string, Promise<import('three').Texture>>} */
const _inflight = new Map();

/**
 * @param {string} path
 * @returns {string}
 */
export function normalizeTextureUrl(path) {
  const src = String(path ?? '').trim();
  if (!src) return '';
  if (src.startsWith('http://') || src.startsWith('https://')) {
    return src.includes(' ') ? src.replace(/ /g, '%20') : src;
  }
  // Root-relative paths match Foundry / tile-manager PIXI loading (modules/, worlds/, …).
  const rooted = src.startsWith('/') ? src : `/${src}`;
  return rooted.includes(' ') ? rooted.replace(/ /g, '%20') : rooted;
}

/**
 * @param {string} url
 * @param {object} options
 * @returns {string}
 */
function _cacheKey(url, options) {
  const role = options?.role ?? 'DATA_MASK';
  const maxSize = options?.maxSize ?? '';
  const premult = options?.premultiplyAlpha ?? '';
  return `${normalizeTextureUrl(url)}::${role}::${maxSize}::${premult}`;
}

/**
 * Resolve createImageBitmap premultiply mode from role / explicit option.
 * @param {string} role
 * @param {'none'|'premultiply'|undefined} explicit
 * @returns {'none'|'premultiply'}
 */
function _resolvePremultiplyAlpha(role, explicit) {
  if (explicit === 'none' || explicit === 'premultiply') return explicit;
  if (role === 'TILE_ALBEDO') return 'none';
  if (role === 'ALBEDO' || role === 'MASK_COLOR') return 'premultiply';
  return 'none';
}

/**
 * @param {string} role
 * @param {number|undefined} explicitMax
 * @returns {number}
 */
function _resolveMaxSize(role, explicitMax) {
  if (typeof explicitMax === 'number') return explicitMax;
  if (role === 'OVERLAY_DATA_MASK' || role === 'TILE_ALBEDO' || role === 'ALBEDO' || role === 'MASK_COLOR') {
    return VISUAL_MASK_MAX_SIZE;
  }
  if (role === 'DATA_MASK') return MASK_MAX_SIZE;
  return MASK_MAX_SIZE;
}

/**
 * Copy ImageBitmap → canvas for stable WebGL upload orientation (matches tile-manager).
 * @param {ImageBitmap} bitmap
 * @returns {CanvasImageSource}
 */
function _stabilizeBitmapOnCanvas(bitmap) {
  let texSource = bitmap;
  try {
    const bw = Number(bitmap?.width ?? 0);
    const bh = Number(bitmap?.height ?? 0);
    if (bw > 0 && bh > 0) {
      const canvasEl = document.createElement('canvas');
      canvasEl.width = bw;
      canvasEl.height = bh;
      const ctx = canvasEl.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, bw, bh);
        texSource = canvasEl;
      }
    }
  } catch (_) {
  }
  try {
    if (texSource !== bitmap && bitmap && typeof bitmap.close === 'function') bitmap.close();
  } catch (_) {
  }
  return texSource;
}

/**
 * Load an image via fetch + createImageBitmap (off-thread decode) and return a configured
 * THREE.Texture. Falls back to TextureLoader on the main thread when ImageBitmap is unavailable.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {'ALBEDO'|'DATA_MASK'|'TILE_ALBEDO'|'OVERLAY_DATA_MASK'|'MASK_COLOR'|'NORMAL_MAP'} [options.role='DATA_MASK']
 * @param {number} [options.maxSize] — downscale if larger (0 = no limit)
 * @param {'none'|'premultiply'} [options.premultiplyAlpha]
 * @param {boolean} [options.stabilizeCanvas=true] — copy bitmap to canvas before upload
 * @param {boolean} [options.markOwned=true] — set userData.mapShineTextureOwned for dispose tracking
 * @returns {Promise<import('three').Texture>}
 */
export async function loadImageTexture(url, options = {}) {
  const src = String(url ?? '').trim();
  if (!src) throw new Error('loadImageTexture: url is required');

  const key = _cacheKey(src, options);
  const existing = _inflight.get(key);
  if (existing) return existing;

  const promise = _loadImageTextureImpl(src, options);
  _inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    _inflight.delete(key);
  }
}

/**
 * @param {string} url
 * @param {object} options
 * @returns {Promise<import('three').Texture>}
 */
async function _loadImageTextureImpl(url, options) {
  const THREE = window.THREE;
  if (!THREE) throw new Error('loadImageTexture: THREE is not available');

  const role = options?.role ?? 'DATA_MASK';
  const absoluteUrl = normalizeTextureUrl(url);
  const maxSize = _resolveMaxSize(role, options?.maxSize);
  const premultiplyAlpha = _resolvePremultiplyAlpha(role, options?.premultiplyAlpha);
  const stabilizeCanvas = options?.stabilizeCanvas !== false;
  const markOwned = options?.markOwned !== false;
  const tryFoundryCache = options?.tryFoundryCache !== false;
  const _shortUrl = srcBasename(url);
  const _dlp = debugLoadingProfiler;
  const _isDbg = _dlp?.debugMode;

  if (tryFoundryCache) {
    const fromPixi = await _tryLoadFromFoundryPixi(absoluteUrl, role, markOwned, stabilizeCanvas);
    if (fromPixi) return fromPixi;
  }

  if (!_hasImageBitmap) {
    return _loadViaTextureLoader(absoluteUrl, role, markOwned);
  }

  if (_isDbg) _dlp.begin(`itl.fetch[${_shortUrl}]`, 'texture');
  const response = await fetch(absoluteUrl);
  if (!response.ok) {
    if (_isDbg) _dlp.end(`itl.fetch[${_shortUrl}]`, { status: response.status });
    throw new Error(`Fetch failed (${response.status}): ${absoluteUrl}`);
  }
  const blob = await response.blob();
  if (_isDbg) _dlp.end(`itl.fetch[${_shortUrl}]`, { bytes: blob.size });

  const bitmapOpts = {
    premultiplyAlpha,
    colorSpaceConversion: 'none',
  };

  if (_isDbg) _dlp.begin(`itl.decode[${_shortUrl}]`, 'texture');
  let bitmap = await createImageBitmap(blob, bitmapOpts);
  if (_isDbg) _dlp.end(`itl.decode[${_shortUrl}]`, { w: bitmap.width, h: bitmap.height });

  if (maxSize > 0 && (bitmap.width > maxSize || bitmap.height > maxSize)) {
    const w = bitmap.width;
    const h = bitmap.height;
    const scale = maxSize / Math.max(w, h);
    const newW = Math.max(1, Math.round(w * scale));
    const newH = Math.max(1, Math.round(h * scale));
    try {
      const resized = await createImageBitmap(bitmap, 0, 0, w, h, {
        resizeWidth: newW,
        resizeHeight: newH,
        resizeQuality: 'medium',
        premultiplyAlpha,
      });
      bitmap.close();
      bitmap = resized;
      log.debug(`Downscaled texture ${absoluteUrl}: ${w}×${h} → ${newW}×${newH}`);
    } catch (_) {
      log.debug(`Resize not supported — keeping full-size ${w}×${h} for ${absoluteUrl}`);
    }
  }

  let texSource = stabilizeCanvas ? _stabilizeBitmapOnCanvas(bitmap) : bitmap;

  const texture = new THREE.Texture(texSource);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  applyTexturePolicy(texture, role);

  if (markOwned) {
    texture.userData = texture.userData || {};
    texture.userData.mapShineTextureOwned = true;
    texture.userData.mapShineDecodePath = 'createImageBitmap';
  }

  texture.needsUpdate = true;
  return texture;
}

/**
 * Use Foundry's loadTexture (PIXI.Assets cache) when the scene already decoded the image.
 * @param {string} absoluteUrl
 * @param {string} role
 * @param {boolean} markOwned
 * @param {boolean} stabilizeCanvas
 * @returns {Promise<import('three').Texture|null>}
 */
async function _tryLoadFromFoundryPixi(absoluteUrl, role, markOwned, stabilizeCanvas) {
  const THREE = window.THREE;
  const loadTextureFn = globalThis.foundry?.canvas?.loadTexture ?? globalThis.loadTexture;
  if (!loadTextureFn) return null;

  try {
    const pixiTexture = await loadTextureFn(absoluteUrl);
    const resource = pixiTexture?.baseTexture?.resource;
    const rawSource = resource?.source;
    if (!rawSource) return null;

    let texSource = rawSource;
    if (
      stabilizeCanvas &&
      (
        rawSource instanceof HTMLImageElement ||
        rawSource instanceof HTMLCanvasElement ||
        rawSource instanceof ImageBitmap
      )
    ) {
      const w = Number(rawSource?.naturalWidth ?? rawSource?.width ?? 0);
      const h = Number(rawSource?.naturalHeight ?? rawSource?.height ?? 0);
      if (w > 0 && h > 0) {
        const canvasEl = document.createElement('canvas');
        canvasEl.width = w;
        canvasEl.height = h;
        const ctx = canvasEl.getContext('2d');
        if (ctx) {
          ctx.drawImage(rawSource, 0, 0, w, h);
          texSource = canvasEl;
        }
      }
    }

    const texture = new THREE.Texture(texSource);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    applyTexturePolicy(texture, role);
    if (markOwned) {
      texture.userData = texture.userData || {};
      texture.userData.mapShineTextureOwned = true;
      texture.userData.mapShineDecodePath = 'foundry.loadTexture';
    }
    texture.needsUpdate = true;
    return texture;
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} absoluteUrl
 * @param {string} role
 * @param {boolean} markOwned
 * @returns {Promise<import('three').Texture>}
 */
function _loadViaTextureLoader(absoluteUrl, role, markOwned) {
  const THREE = window.THREE;
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      absoluteUrl,
      (texture) => {
        applyTexturePolicy(texture, role);
        if (markOwned) {
          texture.userData = texture.userData || {};
          texture.userData.mapShineTextureOwned = true;
          texture.userData.mapShineDecodePath = 'TextureLoader';
        }
        texture.needsUpdate = true;
        resolve(texture);
      },
      undefined,
      reject,
    );
  });
}

/**
 * @param {string} url
 * @returns {string}
 */
function srcBasename(url) {
  const s = String(url || '');
  return s.split('/').pop() || s;
}
