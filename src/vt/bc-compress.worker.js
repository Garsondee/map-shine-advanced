/**
 * @fileoverview vt/bc-compress.worker.js — off-main-thread GPU-texture compression
 * with an IndexedDB cache. The main-thread client is compressed-textures.js.
 *
 * WHY A WORKER (2026-07-18): a 12000² floor is 549 MB as RGBA8, and both floors
 * exceed Chrome's ~2.5 GB WebGPU device-loss wall (measured). BC compression is
 * WebGPU's first-class fix (BC1 = 0.5 byte/px, 8× smaller). But encoding 144
 * megapixels in JS is a multi-second CPU loop, and `getImageData` on a 12000²
 * canvas allocates 576 MB — neither may touch the main thread. So all of it —
 * fetch, decode, opacity check, encode, cache — runs here, and only a small
 * block buffer is transferred back. Nothing is written to Foundry's filesystem
 * (its security model forbids that); the cache lives in the browser's IndexedDB.
 *
 * MEMORY (2026-07-18, the second floor-switch death): reading the WHOLE image
 * back (`getImageData(0,0,w,h)` = 576 MB) alongside the ImageBitmap and the block
 * buffer overran the worker on a 144-megapixel BC7 layer — the encode never
 * returned (bc7:0 in the recorder), so the layer fell to the raw path and
 * uploaded 549 MB, re-killing the device. We now pull the image in 4-row-aligned
 * BANDS (STRIP_ROWS) via a small band canvas and hand each band to the strip
 * driver (encodeStriped in block-compress.js) — peak readback drops to one band
 * (~25 MB for a 12000-wide strip), and the output is bit-identical to a
 * whole-image encode.
 *
 * FORMAT CHOICE: the multifloor composite rides on the ART's alpha holes (you see
 * the floor below through them). BC1 has no alpha, so this worker DECODES, checks
 * opacity, and routes accordingly: fully-opaque images (floor backgrounds) →
 * BC1 (0.5 B/px, 8× smaller); anything with alpha (overhead/roof overlays) → BC7
 * (1 B/px, 4× smaller, carries alpha). Nothing is skipped anymore — the raw
 * 549 MB alpha layers that lost the device on a floor switch are gone.
 *
 * THE MIP CHAIN (2026-07-19, "MSA looks noisier than PIXI when zoomed out" —
 * author screenshot comparison at matched zoom). A block-compressed texture's
 * mip chain can NOT be GPU-auto-generated (verified against three.webgpu.js:
 * `getMipLevels`/`needsMipmaps` key off `texture.mipmaps.length`, not the
 * `generateMipmaps` flag, and there is no compressed-format box-filter pass in
 * the backend) — a single-level BC texture sampled at minification is plain
 * aliasing, which is exactly the gap PIXI's own mipmapped textures don't show.
 * So every level below 0 is encoded here too, in `encodeMipLevel`: each level
 * is downsampled DIRECTLY from the original decoded bitmap (never from the
 * previous mip — one clean resize per level, no compounding blur, the same
 * `imageSmoothingQuality:'high'` technique the raw-fallback path already uses
 * for its own downscale), banded through the SAME memory-bounded strip driver
 * as level 0 so no level, however large, ever holds a full-resolution buffer.
 * Level sizes come from `computeMipChainDims` (block-compress.js) — pure,
 * Node-tested geometry proven to match what a real GPU allocates per level.
 *
 * PROTOCOL: main posts `{ id, src }`; this replies with one of
 *   { id, ok:true, format:'bc1'|'bc7', levels:[{width,height,blocks:ArrayBuffer}], width, height, cached }
 *   { id, ok:false, error }                     (client falls back to raw)
 * `levels[0]` is the full-resolution level; every buffer is transferred, never copied.
 *
 * SECOND JOB (2026-07-24): main may instead post `{ id, src, mode:'alphaGrid' }`
 * and get back `{ id, ok:true, mode:'alphaGrid', width, height, grid:ArrayBuffer,
 * gridW, gridH, cached }` — an item's art opacity reduced to <=512 texels a side,
 * the input `scene/mask-derive.js` needs for `coverAbove`/`skyReach` and has been
 * starved of since the streaming engine was retired. See `vt/coarse-alpha.js`'s
 * header for the defect and why this is a separate resized decode rather than a
 * revived albedo pack. It shares this worker (not a third one) because it is the
 * same kind of work — fetch, decode, reduce, cache — and a worker that is already
 * warm costs nothing to reuse.
 */
import { encodeStriped, computeMipChainDims } from './block-compress.js';
import { coarseAlphaGridDims, extractAlphaGrid } from './coarse-alpha.js';

// Band height for the memory-bounded encode: rows are pulled and encoded
// STRIP_ROWS at a time (rounded to a multiple of 4 by encodeStriped). 512 rows of
// a 12000-wide image is ~25 MB per readback, vs 576 MB for the whole image.
const STRIP_ROWS = 512;

const DB_NAME = 'msa-bc-cache';
const STORE = 'blocks';
// Bump to invalidate every cached entry at once — e.g. an encoder-quality change
// or a format change. Old records simply miss and get re-encoded. v2: alpha
// images now encode to BC7 instead of returning skip, so v1 records are stale.
// v3 (2026-07-18, the "upper floor background is black" hunt): added alphaStats
// to the cache record so a fresh encode carries real diagnostic data — v2
// records have no alphaStats and would otherwise silently report `null` forever.
// v4 (2026-07-19, the mip-chain fix): the record's single `blocks` field became
// a `levels` array — a v3 record has no `levels` and would otherwise be handed
// to the consumer as a texture with no mip chain, silently reproducing the bug
// this version exists to fix.
const CACHE_VERSION = 4;

/**
 * The coarse-alpha cache is versioned SEPARATELY from the BC blocks: the two
 * records answer different questions, are produced by different requests, and
 * bumping one must not throw away megabytes of the other. `alpha:v1:${src}`.
 */
const ALPHA_CACHE_VERSION = 1;

let _dbPromise = null;
function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function cacheGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function cachePut(key, record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Encode ONE mip level below level 0. Scales directly from the ORIGINAL
 * bitmap — never from a previously-encoded mip — to `levelW x levelH`, banded
 * through the same `encodeStriped` driver level 0 uses, so this level (however
 * large) never holds a full-resolution buffer either. See this file's header
 * for why "always from the source" beats progressive halving here.
 * @param {ImageBitmap} bmp - the full-resolution source, still open.
 * @param {number} w @param {number} h - bmp's own pixel size.
 * @param {number} levelW @param {number} levelH - this level's LOGICAL size
 *   (pre-block-padding — `computeMipChainDims`' logicalWidth/logicalHeight).
 * @param {'bc1'|'bc7'} format
 * @returns {Uint8Array} this level's encoded blocks, padded to the block grid.
 */
function encodeMipLevel(bmp, w, h, levelW, levelH, format) {
  const bandH = Math.min(STRIP_ROWS, levelH);
  const bandCanvas = new OffscreenCanvas(levelW, bandH);
  const bandCtx = bandCanvas.getContext('2d', { willReadFrequently: true });
  bandCtx.imageSmoothingEnabled = true;
  bandCtx.imageSmoothingQuality = 'high';
  const readStrip = (y, sh) => {
    bandCtx.clearRect(0, 0, levelW, sh);
    // The source rows that scale down to this level's rows [y, y+sh).
    const srcY = (y / levelH) * h;
    const srcH = (sh / levelH) * h;
    bandCtx.drawImage(bmp, 0, srcY, w, srcH, 0, 0, levelW, sh);
    return bandCtx.getImageData(0, 0, levelW, sh).data;
  };
  return encodeStriped(readStrip, levelW, levelH, format, STRIP_ROWS);
}

/**
 * COARSE ALPHA (see this file's header + vt/coarse-alpha.js). Decode the image
 * DIRECTLY at grid resolution and read back its alpha channel — no full-size
 * bitmap, no encode, no GPU. `resizeQuality:'high'` box-averages, so a texel's
 * value is the fraction of it that is opaque, which is precisely the soft
 * coverage a cast shadow wants at its silhouette.
 *
 * `premultiplyAlpha:'none'` for the same reason the encode path uses it: we want
 * the source alpha the file actually carries, not alpha already folded into RGB.
 *
 * @param {string} src
 * @returns {Promise<{width:number, height:number, gridW:number, gridH:number,
 *   grid:Uint8Array, cached:boolean}>}
 */
async function handleAlphaGrid(src) {
  const key = `alpha:v${ALPHA_CACHE_VERSION}:${src}`;
  const cached = await cacheGet(key).catch(() => null);
  if (cached) {
    return {
      width: cached.width,
      height: cached.height,
      gridW: cached.gridW,
      gridH: cached.gridH,
      grid: cached.grid,
      cached: true,
    };
  }

  const resp = await fetch(src);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${src}`);
  const blob = await resp.blob();
  // Two decodes look wasteful next to `handle()`'s, but they are not the same
  // image in memory: this one asks the DECODER for the reduced size, so the
  // full-resolution buffer never exists here. The fetch above will normally be
  // an HTTP cache hit (the encode path just asked for the same URL).
  const probe = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const width = probe.width;
  const height = probe.height;
  const { w: gridW, h: gridH } = coarseAlphaGridDims(width, height);
  probe.close();

  const small = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
    resizeWidth: gridW,
    resizeHeight: gridH,
    resizeQuality: 'high',
  });
  const canvas = new OffscreenCanvas(gridW, gridH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, gridW, gridH);
  ctx.drawImage(small, 0, 0);
  small.close();
  // vt/ decode-time readback (allowed; see no-gpu-readback) — gridW*gridH*4 is
  // ~1 MB at the 512 cap, not a world-resolution buffer.
  const imageData = ctx.getImageData(0, 0, gridW, gridH);
  const grid = extractAlphaGrid(imageData).data;

  await cachePut(key, { width, height, gridW, gridH, grid }).catch(() => {});
  return { width, height, gridW, gridH, grid, cached: false };
}

async function handle(src) {
  const key = `bc:v${CACHE_VERSION}:${src}`;
  const cached = await cacheGet(key).catch(() => null);
  if (cached) {
    return {
      format: cached.format,
      levels: cached.levels,
      width: cached.width,
      height: cached.height,
      cached: true,
      alphaStats: cached.alphaStats ?? null,
    };
  }

  const resp = await fetch(src);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${src}`);
  const blob = await resp.blob();
  // premultiply/colour-space OFF so the band bytes are the exact sRGB pixels the
  // encoder and the GPU both expect (BC7 stores raw alpha + sRGB-byte RGB; the
  // bc7-...-srgb GPU format decodes RGB via sRGB and passes alpha linearly).
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const w = bmp.width;
  const h = bmp.height;

  // MEMORY-BOUNDED band reader: draw ONLY rows [y, y+bh) of the source into a
  // small band canvas and read that back — never the whole w·h·4 image. The band
  // canvas is w × STRIP_ROWS (or shorter for a small image); each readback is one
  // band (~25 MB for a 12000-wide strip), not 576 MB.
  const bandH = Math.min(STRIP_ROWS, h);
  const bandCanvas = new OffscreenCanvas(w, bandH);
  const bandCtx = bandCanvas.getContext('2d', { willReadFrequently: true });
  const readStrip = (y, sh) => {
    bandCtx.clearRect(0, 0, w, sh);
    // Copy source rows [y, y+sh) to the top of the band canvas, then read them.
    bandCtx.drawImage(bmp, 0, y, w, sh, 0, 0, w, sh);
    return bandCtx.getImageData(0, 0, w, sh).data; // vt/ decode-time readback (allowed; see no-gpu-readback)
  };

  // Opaque → BC1 (8×, half of BC7's size). Any alpha hole → BC7 (4×, carries the
  // holes the multifloor composite needs). Scan opacity in the SAME bands — a
  // FULL pass (no early exit), because this is also where alphaStats comes from
  // (2026-07-18, the "upper floor background renders totally black, isolated,
  // even though its own overhead tile — same format, same dimensions — looks
  // correct" hunt). An early-exit-on-first-violation scan only proves "not fully
  // opaque"; it cannot tell us whether the SOURCE alpha the decoder handed us is
  // mostly-255-with-a-few-holes (expected for a background) or something already
  // wrong (near-zero almost everywhere) BEFORE the BC7 encoder ever touches it —
  // and that distinction is exactly what separates a decode-time bug from an
  // encode-time one. min/max are the two numbers that answer it at a glance.
  let opaque = true;
  let alphaMin = 255;
  let alphaMax = 0;
  let alphaSum = 0;
  let texelCount = 0;
  for (let y = 0; y < h; y += STRIP_ROWS) {
    const sh = Math.min(STRIP_ROWS, h - y);
    const data = readStrip(y, sh);
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i];
      if (a !== 255) opaque = false;
      if (a < alphaMin) alphaMin = a;
      if (a > alphaMax) alphaMax = a;
      alphaSum += a;
      texelCount++;
    }
  }
  const alphaStats = { min: alphaMin, max: alphaMax, mean: texelCount ? +(alphaSum / texelCount).toFixed(2) : null };
  const format = opaque ? 'bc1' : 'bc7';
  // encodeStriped re-reads each band and encodes it into the shared output — the
  // whole image is never resident at once. Result is bit-identical to a
  // whole-image encodeBC1/encodeBC7 (proven in block-compress.test.mjs).
  const level0Blocks = encodeStriped(readStrip, w, h, format, STRIP_ROWS);

  // THE MIP CHAIN — see this file's header. Level 0's PADDED size (not the raw
  // w/h) is the base a real GPU allocates every subsequent level from.
  const padW0 = Math.ceil(w / 4) * 4;
  const padH0 = Math.ceil(h / 4) * 4;
  const dims = computeMipChainDims(padW0, padH0);
  const levels = [{ width: dims[0].width, height: dims[0].height, blocks: level0Blocks.buffer }];
  for (let i = 1; i < dims.length; i++) {
    const d = dims[i];
    const levelBlocks = encodeMipLevel(bmp, w, h, d.logicalWidth, d.logicalHeight, format);
    levels.push({ width: d.width, height: d.height, blocks: levelBlocks.buffer });
  }
  bmp.close();

  // Store the levels (IndexedDB structuredClones every buffer, so the
  // originals stay valid to transfer to the main thread afterwards).
  await cachePut(key, { format, width: w, height: h, levels, alphaStats }).catch(() => {});
  return { format, levels, width: w, height: h, cached: false, alphaStats };
}

self.onmessage = async (e) => {
  const { id, src, mode } = e.data || {};
  try {
    if (mode === 'alphaGrid') {
      const a = await handleAlphaGrid(src);
      // Transfer the grid's buffer. `a.grid` may be a Uint8Array we just built
      // OR one structuredClone'd out of IndexedDB — either way its buffer is
      // ours to give away, and the record in the DB is a separate copy.
      self.postMessage(
        {
          id,
          ok: true,
          mode: 'alphaGrid',
          width: a.width,
          height: a.height,
          gridW: a.gridW,
          gridH: a.gridH,
          grid: a.grid.buffer,
          cached: a.cached,
        },
        [a.grid.buffer]
      );
      return;
    }
    const r = await handle(src);
    self.postMessage(
      {
        id,
        ok: true,
        format: r.format,
        levels: r.levels,
        width: r.width,
        height: r.height,
        cached: r.cached,
        alphaStats: r.alphaStats,
      },
      // Every level's buffer is transferred, never copied — same contract as
      // the old single-buffer message, just one entry per mip level now.
      r.levels.map((lvl) => lvl.blocks)
    );
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
