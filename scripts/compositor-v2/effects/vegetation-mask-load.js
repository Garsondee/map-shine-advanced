/**
 * @fileoverview Shared CPU helpers for Bush/Tree mask load (readback, probe batching).
 * @module compositor-v2/effects/vegetation-mask-load
 */

/** Max dimension for Tree hover opacity CPU cache. */
export const VEGETATION_ALPHA_SAMPLE_MAX_DIM = 512;
/** Max dimension for vegetation mask CPU readback (matches clump bake cap). */
export const VEGETATION_MASK_READ_MAX_DIM = 1024;

/** @type {{ enqueue: (fn: () => void|Promise<void>) => Promise<void> }|null} */
let _sharedMaskLoadQueue = null;

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
