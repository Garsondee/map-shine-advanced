/**
 * @fileoverview Shared CPU helpers for Bush/Tree mask load (readback, probe batching).
 * @module compositor-v2/effects/vegetation-mask-load
 */

import { buildClumpCoordTexture } from './vegetation-clump-field.js';
import { createLogger } from '../../core/log.js';

const log = createLogger('VegetationMaskLoad');

/** Max dimension for Tree hover opacity CPU cache. */
export const VEGETATION_ALPHA_SAMPLE_MAX_DIM = 512;
/** Max dimension for vegetation mask CPU readback (matches clump bake cap). */
export const VEGETATION_MASK_READ_MAX_DIM = 1024;
/**
 * Hard cap on the resolution of the vegetation mask GPU texture (Tree/Bush).
 *
 * Authored masks ship at full scene resolution (e.g. 12000×12000 = 144 MP =
 * ~576 MB as an RGBA GPU texture). A vegetation coverage/placement mask is a
 * SOFT spatial field, UV-sampled by the shader — it gains nothing from that
 * resolution but costs enormous VRAM AND forces every CPU readback
 * ({@link readMaskImageData}, the clump bake, alpha sampling) to decode/downscale
 * from the full 144 MP source on the main thread, a multi-second synchronous
 * stall that trips the GPU driver watchdog (TDR) during load. Capping the mask
 * ONCE, at load, means the GPU upload and every downstream read work from a
 * small copy. 2048 keeps coverage edges crisp on-screen while cutting a 12000²
 * source 36× (144 MP → ~4 MP). Applies to Tree and Bush (shared loader).
 */
export const VEGETATION_MASK_MAX_TEXTURE_DIM = 2048;

/** Max stream-cell overlays created per sync (avoids load spikes). */
export const VEGETATION_STREAM_OVERLAY_CREATE_BUDGET = 2;

/** @type {{ enqueue: (fn: () => void|Promise<void>) => Promise<void> }|null} */
let _sharedMaskLoadQueue = null;

/** @type {Map<string, { tex: import('three').Texture|null, refCount: number, loading: Promise<import('three').Texture>|null }>} */
const _sharedMaskTextures = new Map();

/** @type {Map<string, { data: Uint8ClampedArray, width: number, height: number, srcWidth: number, srcHeight: number }>} */
const _sharedMaskReadbacks = new Map();

/** @type {Map<string, { texture: import('three').DataTexture, islandBySeed: object|null, primaryAnchor: object|null, islandCount: number, refCount: number }>} */
const _sharedClumpBakes = new Map();

/**
 * Global bounded queue for vegetation mask post-load CPU work (readback + clump bake).
 * @param {number} [concurrency=2]
 */
export function getVegetationMaskLoadQueue(concurrency = 2) {
  if (_sharedMaskLoadQueue) return _sharedMaskLoadQueue;
  let active = 0;
  /** @type {Array<{ fn: () => void|Promise<void>, resolve: () => void, reject: (err: unknown) => void }>} */
  const pending = [];

  const pump = () => {
    while (active < concurrency && pending.length > 0) {
      const job = pending.shift();
      if (!job) break;
      active += 1;
      Promise.resolve()
        .then(() => job.fn())
        .then(() => { job.resolve(); })
        .catch((err) => { job.reject(err); })
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  _sharedMaskLoadQueue = {
    enqueue(fn) {
      return new Promise((resolve, reject) => {
        pending.push({ fn, resolve, reject });
        pump();
      });
    },
  };
  return _sharedMaskLoadQueue;
}

/** @type {Map<string, boolean>} */
const _sharedDeriveAlphaByUrl = new Map();

/**
 * @param {string} url
 * @returns {string}
 */
export function vegetationSharedClumpKey(url, deriveAlpha) {
  return `${String(url || '')}|${deriveAlpha ? 1 : 0}`;
}

/**
 * Configure sRGB on a loaded vegetation mask texture.
 * @param {import('three').Texture} tex
 */
export function configureVegetationMaskTexture(tex) {
  const THREE = window.THREE;
  if (!tex) return;
  tex.flipY = true;
  if ('colorSpace' in tex && THREE?.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  else if ('encoding' in tex && THREE?.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
  tex.needsUpdate = true;
}

/**
 * Cap a freshly-loaded vegetation mask texture to {@link VEGETATION_MASK_MAX_TEXTURE_DIM}
 * by replacing its `.image` with a downscaled canvas, so the GPU upload and every
 * later CPU readback work from the small copy instead of the full-res source.
 *
 * The one-time downscale `drawImage` is a native (GPU/native) resample of the
 * already-decoded source — cheap — and happens at most once per unique mask URL
 * (the caller caches by URL). Fails open: on any error the original texture is
 * returned unchanged, so a bad cap can never break mask loading.
 *
 * @param {import('three').Texture} tex
 * @param {number} maxDim
 * @returns {import('three').Texture}
 */
function capVegetationMaskTexture(tex, maxDim) {
  try {
    const img = tex?.image;
    if (!img) return tex;
    const w = Number(img.naturalWidth || img.videoWidth || img.width || 0);
    const h = Number(img.naturalHeight || img.videoHeight || img.height || 0);
    if (!(w > 0 && h > 0)) return tex;
    const longest = Math.max(w, h);
    if (longest <= maxDim) return tex;

    const scale = maxDim / longest;
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return tex;
    ctx.drawImage(img, 0, 0, outW, outH);

    tex.image = canvas;
    tex.needsUpdate = true;
    // Release the full-res decoded bitmap where the platform allows it.
    try { if (typeof img.close === 'function') img.close(); } catch (_) {}

    log.info(`Vegetation mask capped ${w}×${h} → ${outW}×${outH} (${((w * h) / 1e6).toFixed(0)} MP → ${((outW * outH) / 1e6).toFixed(1)} MP)`);
    return tex;
  } catch (err) {
    log.warn('Vegetation mask cap failed; using full-res source', err);
    return tex;
  }
}

/**
 * Load or reuse one GPU mask texture per URL (stream cells share the same full-scene mask).
 * @param {import('three').TextureLoader} loader
 * @param {string} url
 * @returns {Promise<import('three').Texture>}
 */
export function acquireVegetationMaskTexture(loader, url) {
  const key = String(url || '').trim();
  if (!loader || !key) return Promise.reject(new Error('acquireVegetationMaskTexture: missing loader or url'));

  const existing = _sharedMaskTextures.get(key);
  if (existing?.tex) {
    existing.refCount += 1;
    return Promise.resolve(existing.tex);
  }
  if (existing?.loading) {
    return existing.loading.then((tex) => {
      existing.refCount += 1;
      return tex;
    });
  }

  /** @type {{ tex: import('three').Texture|null, refCount: number, loading: Promise<import('three').Texture>|null }} */
  const slot = { tex: null, refCount: 1, loading: null };
  _sharedMaskTextures.set(key, slot);
  slot.loading = new Promise((resolve, reject) => {
    loader.load(
      key,
      (tex) => {
        configureVegetationMaskTexture(tex);
        const capped = capVegetationMaskTexture(tex, VEGETATION_MASK_MAX_TEXTURE_DIM);
        slot.tex = capped;
        slot.loading = null;
        resolve(capped);
      },
      undefined,
      (err) => {
        if (_sharedMaskTextures.get(key) === slot) _sharedMaskTextures.delete(key);
        slot.loading = null;
        reject(err);
      },
    );
  });
  return slot.loading;
}

/**
 * @param {string} url
 */
export function releaseVegetationMaskTexture(url) {
  const key = String(url || '').trim();
  const slot = _sharedMaskTextures.get(key);
  if (!slot) return;
  slot.refCount = Math.max(0, slot.refCount - 1);
  if (slot.refCount > 0) return;
  try { slot.tex?.dispose?.(); } catch (_) {}
  _sharedMaskTextures.delete(key);
  _sharedMaskReadbacks.delete(key);
  _sharedDeriveAlphaByUrl.delete(key);
}

/**
 * Cached CPU readback for a shared mask URL.
 * @param {string} url
 * @param {import('three').Texture} tex
 * @returns {{ data: Uint8ClampedArray, width: number, height: number, srcWidth: number, srcHeight: number }|null}
 */
export function getSharedVegetationMaskReadback(url, tex) {
  const key = String(url || '').trim();
  if (!key) return null;
  const cached = _sharedMaskReadbacks.get(key);
  if (cached) return cached;
  const read = readMaskImageData(tex, VEGETATION_MASK_READ_MAX_DIM);
  if (read) _sharedMaskReadbacks.set(key, read);
  return read;
}

/**
 * Whether a vegetation mask needs derive-alpha (white backdrop in opaque alpha).
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @returns {boolean}
 */
export function detectVegetationBackdropNeedsDeriveAlpha(data, width, height) {
  if (!data || !(width > 0) || !(height > 0)) return true;
  const pixelCount = width * height;
  let anyLowAlpha = false;
  let whiteOpaque = 0;
  let sampled = 0;
  const stride = pixelCount > 262144 ? Math.ceil(pixelCount / 262144) : 1;
  for (let i = 0; i < pixelCount; i += stride) {
    sampled += 1;
    const idx = i * 4;
    const a = data[idx + 3];
    if (a < 250) {
      anyLowAlpha = true;
      continue;
    }
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (lum >= 217 && chroma < 15) whiteOpaque += 1;
  }
  if (!anyLowAlpha) return true;
  return whiteOpaque > sampled * 0.02;
}

/**
 * Cached derive-alpha flag for a shared vegetation mask URL.
 * @param {string} url
 * @param {import('three').Texture} tex
 * @returns {boolean}
 */
export function inferVegetationMaskDeriveAlpha(url, tex) {
  const key = String(url || '').trim();
  if (!key) return true;
  const maskRead = getSharedVegetationMaskReadback(key, tex);
  const path = key.toLowerCase();
  if (path.includes('_bush') || path.includes('_tree')) {
    return true;
  }
  if (!maskRead) return false;
  return detectDerivedAlphaFromImageData(maskRead.data, maskRead.width, maskRead.height);
}

/**
 * Cached derive-alpha flag for a shared vegetation mask URL.
 * @param {string} url
 * @param {import('three').Texture} tex
 * @returns {boolean}
 */
export function getSharedVegetationDeriveAlpha(url, tex) {
  const key = String(url || '').trim();
  if (!key) return true;
  const path = key.toLowerCase();
  if (path.includes('_bush') || path.includes('_tree')) {
    _sharedDeriveAlphaByUrl.set(key, true);
    return true;
  }
  if (_sharedDeriveAlphaByUrl.has(key)) return _sharedDeriveAlphaByUrl.get(key) === true;
  const derive = inferVegetationMaskDeriveAlpha(key, tex);
  _sharedDeriveAlphaByUrl.set(key, derive);
  return derive;
}

/**
 * @param {string} cacheKey
 * @param {() => ReturnType<typeof buildClumpCoordTexture>} factory
 */
export function acquireSharedClumpBake(cacheKey, factory) {
  const key = String(cacheKey || '').trim();
  if (!key) return null;
  const existing = _sharedClumpBakes.get(key);
  if (existing) {
    existing.refCount += 1;
    return existing;
  }
  const built = factory();
  if (!built?.texture) return null;
  const slot = {
    texture: built.texture,
    islandBySeed: built.islandBySeed ?? null,
    primaryAnchor: built.primaryAnchor ?? null,
    islandCount: Number(built.islandCount) || 1,
    refCount: 1,
  };
  _sharedClumpBakes.set(key, slot);
  return slot;
}

/**
 * @param {string} cacheKey
 */
export function releaseSharedClumpBake(cacheKey) {
  const key = String(cacheKey || '').trim();
  const slot = _sharedClumpBakes.get(key);
  if (!slot) return;
  slot.refCount = Math.max(0, slot.refCount - 1);
  if (slot.refCount > 0) return;
  try { slot.texture?.dispose?.(); } catch (_) {}
  _sharedClumpBakes.delete(key);
}

/**
 * Bake or reuse a full-scene clump field for stream-split overlays.
 * @param {string} cacheKey
 * @param {import('three').Texture} tex
 * @param {boolean} deriveAlpha
 * @param {object} clumpPlacement
 * @param {object|null} imageDataOpts
 */
export function acquireSharedClumpBakeFromMask(cacheKey, tex, deriveAlpha, clumpPlacement, imageDataOpts = null) {
  return acquireSharedClumpBake(cacheKey, () => buildClumpCoordTexture(
    tex,
    deriveAlpha,
    clumpPlacement,
    imageDataOpts,
  ));
}

/** Yield one animation frame so populate does not spawn every overlay in one turn. */
export function yieldVegetationPopulateFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * Bounded parallel mask path resolution during vegetation populate.
 * @param {string[]} basePaths
 * @param {(basePath: string, suffix: string) => Promise<string|null>} probeFn
 * @param {string} suffix
 * @param {Set<string>} negativeCache
 * @param {number} [concurrency=12]
 * @returns {Promise<Map<string, string|null>>}
 */
export async function probeVegetationMaskPathsBatch(
  basePaths,
  probeFn,
  suffix,
  negativeCache,
  concurrency = 12,
) {
  const unique = [];
  const seen = new Set();
  for (const bp of basePaths) {
    const path = String(bp || '').trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }

  const out = new Map();
  for (const path of unique) {
    if (negativeCache.has(path)) out.set(path, null);
  }

  const pending = unique.filter((path) => !out.has(path));
  if (!pending.length) return out;

  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), pending.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < pending.length) {
      const index = cursor;
      cursor += 1;
      const basePath = pending[index];
      try {
        const url = await probeFn(basePath, suffix);
        out.set(basePath, url ?? null);
      } catch (_) {
        out.set(basePath, null);
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Read mask pixels from a loaded THREE.Texture (optional downscale).
 * @param {import('three').Texture} texture
 * @param {number} [maxDim=0] When > 0, downscale so longest edge <= maxDim.
 * @returns {{ data: Uint8ClampedArray, width: number, height: number, srcWidth: number, srcHeight: number }|null}
 */
export function readMaskImageData(texture, maxDim = 0) {
  try {
    const img = texture?.image;
    if (!img) return null;

    const srcWidth = Number(img.naturalWidth || img.videoWidth || img.width || 0);
    const srcHeight = Number(img.naturalHeight || img.videoHeight || img.height || 0);
    if (!(srcWidth > 0 && srcHeight > 0)) return null;

    let width = srcWidth;
    let height = srcHeight;
    if (maxDim > 0) {
      const longest = Math.max(width, height);
      if (longest > maxDim) {
        const scale = maxDim / longest;
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }
    }

    const canvasEl = document.createElement('canvas');
    canvasEl.width = width;
    canvasEl.height = height;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    return {
      data: imageData.data,
      width,
      height,
      srcWidth,
      srcHeight,
    };
  } catch (_) {
    return null;
  }
}

/**
 * True when every sampled pixel alpha is effectively opaque (derived-alpha masks).
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @returns {boolean}
 */
export function detectDerivedAlphaFromImageData(data, width, height) {
  if (!data || !(width > 0) || !(height > 0)) return false;
  const pixelCount = width * height;
  for (let i = 3; i < pixelCount * 4; i += 4) {
    if (data[i] < 250) return false;
  }
  return true;
}

/**
 * Downscaled RGBA cache for CPU hover opacity sampling.
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @param {number} [maxDim=VEGETATION_ALPHA_SAMPLE_MAX_DIM]
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }}
 */
export function buildAlphaSampleCache(data, width, height, maxDim = VEGETATION_ALPHA_SAMPLE_MAX_DIM) {
  if (!data || !(width > 0) || !(height > 0)) {
    return { width: 0, height: 0, data: new Uint8ClampedArray(0) };
  }
  if (Math.max(width, height) <= maxDim) {
    return { width, height, data };
  }

  const scale = maxDim / Math.max(width, height);
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const canvasEl = document.createElement('canvas');
  canvasEl.width = outW;
  canvasEl.height = outH;
  const ctx = canvasEl.getContext('2d');
  if (!ctx) return { width, height, data };

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = width;
  srcCanvas.height = height;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) return { width, height, data };

  const srcImage = srcCtx.createImageData(width, height);
  srcImage.data.set(data);
  srcCtx.putImageData(srcImage, 0, 0);
  ctx.drawImage(srcCanvas, 0, 0, outW, outH);
  const out = ctx.getImageData(0, 0, outW, outH);
  return { width: outW, height: outH, data: out.data };
}
