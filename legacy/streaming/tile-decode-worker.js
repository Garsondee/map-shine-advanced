/**
 * @fileoverview Off-thread pyramid tile decode — decode source once, slice cells, persist WebP to IDB.
 * @module streaming/tile-decode-worker
 */

import { idbGetTileBlob, idbPutTileBlob } from './pyramid-indexed-db.js';

/** @typedef {{ sourceKey: string, bitmap: ImageBitmap, width: number, height: number }} SourceState */

/** @type {Map<string, SourceState>} */
const _sources = new Map();

/** @type {Map<string, Promise<void>>} */
const _sourceDecodePromises = new Map();

/** @type {{ done: number, total: number, sourceKey: string|null }} */
const _bakeProgress = { done: 0, total: 0, sourceKey: null };

/**
 * @param {number} cellSize
 * @param {number} lod
 * @returns {number}
 */
function lodPixelSize(cellSize, lod) {
  const shift = Math.max(0, Math.min(6, Math.floor(lod)));
  return Math.max(64, Math.floor(cellSize / (2 ** shift)));
}

/**
 * @param {ImageBitmap} bitmap
 * @param {number} quality
 * @returns {Promise<Blob|null>}
 */
async function bitmapToWebpBlob(bitmap, quality = 0.9) {
  try {
    const cv = new OffscreenCanvas(bitmap.width, bitmap.height);
    const cx = cv.getContext('2d');
    if (!cx) return null;
    cx.drawImage(bitmap, 0, 0);
    return await cv.convertToBlob({ type: 'image/webp', quality });
  } catch (_) {
    return null;
  }
}

/**
 * @param {ImageBitmap} master
 * @param {number} sx
 * @param {number} sy
 * @param {number} sw
 * @param {number} sh
 * @param {number} outW
 * @param {number} outH
 * @param {boolean} fastSharpen
 * @returns {Promise<ImageBitmap>}
 */
async function sliceAndResize(master, sx, sy, sw, sh, outW, outH, fastSharpen = false) {
  return createImageBitmap(master, sx, sy, sw, sh, {
    resizeWidth: outW,
    resizeHeight: outH,
    resizeQuality: fastSharpen ? 'low' : 'medium',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
}

/**
 * @param {string} sourceKey
 * @param {Blob} blob
 * @param {number} width
 * @param {number} height
 * @returns {Promise<void>}
 */
async function ensureSourceDecoded(sourceKey, blob, width, height) {
  if (_sources.has(sourceKey)) return;
  let pending = _sourceDecodePromises.get(sourceKey);
  if (pending) {
    await pending;
    return;
  }

  pending = (async () => {
    const bitmap = await createImageBitmap(blob, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
    _sources.set(sourceKey, {
      sourceKey,
      bitmap,
      width: width || bitmap.width,
      height: height || bitmap.height,
    });
    self.postMessage({
      type: 'source-ready',
      sourceKey,
      width: width || bitmap.width,
      height: height || bitmap.height,
    });
  })();

  _sourceDecodePromises.set(sourceKey, pending);
  try {
    await pending;
  } finally {
    _sourceDecodePromises.delete(sourceKey);
  }
}

/**
 * @param {object} req
 * @returns {Promise<ImageBitmap|null>}
 */
/**
 * @param {object} req
 * @param {boolean} [persistOnly=false] When true, write IDB only — never return a bitmap.
 * @returns {Promise<ImageBitmap|null>}
 */
async function bakeTile(req, persistOnly = false) {
  const {
    sourceKey,
    cacheKey,
    cellX,
    cellY,
    lod,
    cellSize,
    sourceWidth,
    sourceHeight,
    fastSharpen = false,
  } = req;

  const cached = await idbGetTileBlob(cacheKey);
  if (cached) {
    if (persistOnly) return null;
    return createImageBitmap(cached, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
  }

  const source = _sources.get(sourceKey);
  if (!source?.bitmap) return null;

  const cs = Math.max(512, cellSize);
  const sx = cellX * cs;
  const sy = cellY * cs;
  if (sx >= sourceWidth || sy >= sourceHeight) return null;
  const sw = Math.min(cs, sourceWidth - sx);
  const sh = Math.min(cs, sourceHeight - sy);
  if (!(sw > 0 && sh > 0)) return null;

  const outPx = lodPixelSize(cs, lod);
  const outH = Math.max(1, Math.round(outPx * (sh / sw)));

  const bitmap = await sliceAndResize(
    source.bitmap,
    sx, sy, sw, sh,
    outPx, outH,
    fastSharpen,
  );

  try {
    const webpBlob = await bitmapToWebpBlob(bitmap, fastSharpen ? 0.85 : 0.92);
    if (webpBlob) await idbPutTileBlob(cacheKey, webpBlob);
  } catch (_) {}

  if (_bakeProgress.total > 0) {
    _bakeProgress.done += 1;
    self.postMessage({
      type: 'bake-progress',
      sourceKey,
      done: _bakeProgress.done,
      total: _bakeProgress.total,
    });
  }

  if (persistOnly) {
    try { bitmap.close(); } catch (_) {}
    return null;
  }
  return bitmap;
}

/**
 * @param {object} msg
 */
async function handleMessage(msg) {
  const { type, id } = msg;

  if (type === 'ping') {
    self.postMessage({ type: 'pong', id, workerId: msg.workerId });
    return;
  }

  if (type === 'ensure-source') {
    try {
      await ensureSourceDecoded(msg.sourceKey, msg.blob, msg.width, msg.height);
      self.postMessage({ type: 'ensure-source-done', id, sourceKey: msg.sourceKey });
    } catch (err) {
      self.postMessage({
        type: 'error',
        id,
        sourceKey: msg.sourceKey,
        message: String(err?.message ?? err),
      });
    }
    return;
  }

  if (type === 'bake-tile-idb') {
    try {
      if (!_sources.has(msg.sourceKey)) {
        if (!msg.blob) {
          self.postMessage({
            type: 'tile-idb-done',
            id,
            cacheKey: msg.cacheKey,
            ok: false,
          });
          return;
        }
        await ensureSourceDecoded(msg.sourceKey, msg.blob, msg.sourceWidth, msg.sourceHeight);
      }
      await bakeTile(msg, true);
      self.postMessage({
        type: 'tile-idb-done',
        id,
        cacheKey: msg.cacheKey,
        ok: true,
      });
    } catch (err) {
      self.postMessage({
        type: 'tile-idb-done',
        id,
        cacheKey: msg.cacheKey,
        ok: false,
        message: String(err?.message ?? err),
      });
    }
    return;
  }

  if (type === 'request-tile') {
    try {
      if (!_sources.has(msg.sourceKey)) {
        if (!msg.blob) {
          self.postMessage({
            type: 'tile-error',
            id,
            cacheKey: msg.cacheKey,
            message: 'source not loaded',
          });
          return;
        }
        await ensureSourceDecoded(msg.sourceKey, msg.blob, msg.sourceWidth, msg.sourceHeight);
      }

      const bitmap = await bakeTile(msg);
      if (!bitmap) {
        self.postMessage({ type: 'tile-error', id, cacheKey: msg.cacheKey, message: 'decode failed' });
        return;
      }
      self.postMessage(
        { type: 'tile-ready', id, cacheKey: msg.cacheKey, sourceKey: msg.sourceKey, bitmap },
        [bitmap],
      );
    } catch (err) {
      self.postMessage({
        type: 'tile-error',
        id,
        cacheKey: msg.cacheKey,
        message: String(err?.message ?? err),
      });
    }
    return;
  }

  if (type === 'set-bake-total') {
    _bakeProgress.sourceKey = msg.sourceKey;
    _bakeProgress.done = Math.max(0, Number(msg.done) || 0);
    _bakeProgress.total = Math.max(0, Number(msg.total) || 0);
    self.postMessage({
      type: 'bake-progress',
      sourceKey: msg.sourceKey,
      done: _bakeProgress.done,
      total: _bakeProgress.total,
    });
    return;
  }

  if (type === 'release-source') {
    const state = _sources.get(msg.sourceKey);
    if (state?.bitmap) {
      try { state.bitmap.close(); } catch (_) {}
    }
    _sources.delete(msg.sourceKey);
    self.postMessage({ type: 'source-released', sourceKey: msg.sourceKey });
    return;
  }
}

self.addEventListener('message', (ev) => {
  void handleMessage(ev.data ?? {});
});

self.postMessage({ type: 'worker-ready' });
