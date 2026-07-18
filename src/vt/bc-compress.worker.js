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
 * PROTOCOL: main posts `{ id, src }`; this replies with one of
 *   { id, ok:true, format:'bc1'|'bc7', blocks:ArrayBuffer, width, height, cached }
 *   { id, ok:false, error }                     (client falls back to raw)
 * The block buffer is transferred, never copied.
 */
import { encodeStriped } from './block-compress.js';

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
const CACHE_VERSION = 3;

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

async function handle(src) {
  const key = `bc:v${CACHE_VERSION}:${src}`;
  const cached = await cacheGet(key).catch(() => null);
  if (cached) {
    return {
      format: cached.format,
      blocks: cached.blocks,
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
  const blocks = encodeStriped(readStrip, w, h, format, STRIP_ROWS);
  bmp.close();
  // Store the blocks (IndexedDB structuredClones the buffer, so the original
  // stays valid to transfer to the main thread afterwards).
  await cachePut(key, { format, width: w, height: h, blocks: blocks.buffer, alphaStats }).catch(() => {});
  return { format, blocks: blocks.buffer, width: w, height: h, cached: false, alphaStats };
}

self.onmessage = async (e) => {
  const { id, src } = e.data || {};
  try {
    const r = await handle(src);
    self.postMessage(
      {
        id,
        ok: true,
        format: r.format,
        blocks: r.blocks,
        width: r.width,
        height: r.height,
        cached: r.cached,
        alphaStats: r.alphaStats,
      },
      [r.blocks]
    );
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
