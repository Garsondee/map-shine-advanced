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
 * So every level below 0 is encoded here too. Level sizes come from
 * `computeMipChainDims` (block-compress.js) — pure, Node-tested geometry proven
 * to match what a real GPU allocates per level.
 *
 * HOW THOSE LEVELS ARE REDUCED (2026-07-28, second author round: "large zoom out
 * makes areas look a bit pixelated" AND "the edges of tiles, where the alpha
 * might be less than 100% are very degraded when I zoom out"). This used to
 * scale each level straight off the source bitmap with `drawImage` +
 * `imageSmoothingQuality:'high'`. That is gone, for two independent reasons:
 *
 *  - QUALITY. `drawImage`'s kernel is unspecified, varies by Chrome version, and
 *    for large reductions has historically degraded to mipmap+bilinear — i.e.
 *    aliasing, which the clarity sharpen then amplifies into visible pixelation.
 *    `mip-resample.js` does an explicit Lanczos-2 reduction instead: sharper
 *    than the box filter PIXI's `gl.generateMipmap` uses, and deterministic and
 *    Node-testable rather than a browser black box.
 *
 *  - ALPHA. A 2D canvas stores premultiplied and `getImageData`
 *    un-premultiplies, so transparent texels came back as RGB 0 whatever the
 *    artist painted — and since the GPU filters straight-alpha RGBA without
 *    weighting by coverage, every soft tile edge was being dragged toward black,
 *    worse the coarser the mip. The reducer filters in premultiplied space and
 *    dilates recovered colour outward into the transparent region. See
 *    mip-resample.js's header for the full mechanism.
 *
 * The chain now CASCADES (level i from level i-1) rather than re-reducing the
 * source each time: an explicit direct 16x reduction would need a vertical
 * kernel spanning the whole image (~182 MB held for a 6750² floor), while a
 * halve always spans 8 source rows and stays banded. Level 1 reads the source
 * through the same band canvas as level 0, widened to the padded level-0 grid so
 * the art keeps a constant footprint fraction at every level — which is also
 * what makes the material's single `uvScale` correct on levels below 0, where it
 * previously drifted by about two texels at the far edge.
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
// The mip reducer (Lanczos-2, premultiplied, dilated). Replaced the
// OffscreenCanvas `drawImage` resize this file used to rely on — see
// mip-resample.js's header for the two author-reported defects that motivated
// it ("pixelated at large zoom out", "tile edges very degraded when I zoom out").
import { halveRGBA } from './mip-resample.js';

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
// v5 (2026-07-28, the clarity round): the mip chain is now Lanczos-2 reduced in
// PREMULTIPLIED space with dilated transparent RGB (mip-resample.js), not a
// canvas `drawImage` resize. Every v4 record holds visibly different — softer,
// and black-fringed at every alpha edge — mip data, so they must all miss.
// v6 (2026-07-28, "I re-uploaded a graphic and the old one is still showing"):
// the cache was keyed on the source URL ALONE, forever — a same-name re-upload
// with different bytes (the author's own repro: repainted a sign onto a tile,
// re-uploaded, the sign never appeared) returned the OLD encode until the end
// of time, with nothing to distinguish "unchanged" from "edited ten minutes
// ago". Records now carry the source's ETag/Last-Modified/Content-Length, and
// a HIT is verified against a live HEAD before being trusted (`isSameResource`
// below). v5 records carry none of these fields, so they always fail that
// check once and re-encode — the correct behaviour for a record that can no
// longer be vouched for, and exactly why this bump doesn't also need special-
// casing the old shape.
// v7 (2026-07-28, same day: "diagonal parts of the black outline disappear/are
// mushed" on cutout tile art zoomed out). encodeBC1Block/encodeBC7Block
// (block-compress.js's "SECOND ENDPOINT CANDIDATE" section header) now score a
// second candidate endpoint pair per 4×4 block — a v6 record was encoded
// before that existed, so a thick ink outline crossing a diagonal silhouette
// edge is measurably crushed (diagonal ink measured luma 59.1 avg / 78.8 max
// against a source of 10, vs an EXACT match for the same ring's axis-aligned
// texels) in every v6 record and must be re-encoded, not just re-served.
const CACHE_VERSION = 7;

/**
 * The coarse-alpha cache is versioned SEPARATELY from the BC blocks: the two
 * records answer different questions, are produced by different requests, and
 * bumping one must not throw away megabytes of the other. `alpha:v2:${src}`.
 * v2 (2026-07-28): same freshness fix and same reasoning as CACHE_VERSION.
 */
const ALPHA_CACHE_VERSION = 2;

/**
 * A cheap HEAD request for `src`'s CURRENT identity on the server — whichever
 * of ETag / Last-Modified / Content-Length it sends. Used to verify a cached
 * record is still describing the SAME bytes before trusting it, without
 * paying for a full download + decode + re-encode on every load — the whole
 * point of the cache.
 *
 * DEGRADATION-FIRST, the same posture as every other network call in this
 * file (this file's own header: compression must never break rendering). A
 * failed HEAD (network hiccup, a server/proxy that rejects HEAD) returns
 * `null` rather than throwing; the caller's fallback for `null` is to trust
 * the existing cache record, which is no worse than this check not existing.
 *
 * @param {string} src
 * @returns {Promise<{etag: string|null, lastModified: string|null, contentLength: string|null}|null>}
 */
async function headSource(src) {
  try {
    const resp = await fetch(src, { method: 'HEAD' });
    if (!resp.ok) return null;
    return {
      etag: resp.headers.get('etag'),
      lastModified: resp.headers.get('last-modified'),
      contentLength: resp.headers.get('content-length'),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Does a cached record's stored identity still match what the server reports
 * RIGHT NOW? ANY validator both sides carry that DISAGREES means the file
 * changed — this errs toward a spurious re-encode over a stale texture, on
 * purpose: re-encoding something that was actually unchanged costs a few CPU
 * seconds once; serving stale bytes forever is invisible and is the exact bug
 * this exists to kill.
 *
 * A record with NO stored validators at all (every pre-v6/v2 record, since
 * they predate this field existing) always returns `false` — combined with
 * this file's CACHE_VERSION/ALPHA_CACHE_VERSION bump, that means every old
 * record re-encodes itself exactly once and never needs a special case here.
 *
 * `live === null` (the HEAD request itself couldn't be completed) trusts the
 * cache rather than penalising a transient network failure for something
 * unrelated to the file's own freshness.
 *
 * @param {{etag?:string|null, lastModified?:string|null, contentLength?:string|null}} cached
 * @param {{etag: string|null, lastModified: string|null, contentLength: string|null}|null} live
 * @returns {boolean}
 */
function isSameResource(cached, live) {
  if (!live) return true;
  if (!cached.etag && !cached.lastModified && !cached.contentLength) return false;
  if (cached.contentLength && live.contentLength && cached.contentLength !== live.contentLength) return false;
  if (cached.etag && live.etag && cached.etag !== live.etag) return false;
  if (cached.lastModified && live.lastModified && cached.lastModified !== live.lastModified) return false;
  return true;
}

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
 * A band reader over the source bitmap WIDENED to the padded level-0 grid, for
 * `halveRGBA` to cascade from.
 *
 * WHY PAD BEFORE REDUCING, rather than reducing the raw w×h and padding after:
 * the GPU allocates mip level i as `padW0 >> i`, so the chain has to descend
 * from the PADDED base or every level's size drifts from what was allocated.
 * Reducing the padded grid also keeps the image's own footprint at a CONSTANT
 * fraction of every level — level 0 holds the art in 6750 of 6752 texels, level
 * 1 in 3375 of 3376, and those are the same ratio. That matters because the
 * material applies ONE `uvScale` (computed from level 0) to every level: before
 * this, levels 1+ held the art across their FULL width, so the uv crop was
 * fractionally wrong on every level but the first — about two texels of drift at
 * the far edge, ghosting between levels wherever trilinear blended them.
 *
 * Rows past the image are edge-clamped copies of the last real row, columns past
 * it copies of the last real column — the same clamp `encodeStriped` already
 * applies at the block grid, so padding introduces no new colour anywhere.
 *
 * @param {(y:number, sh:number)=>Uint8Array|Uint8ClampedArray} readStrip - the
 *   caller's w-wide band reader (the shared band canvas).
 * @param {number} w @param {number} h - the image's own size.
 * @param {number} padW0 - the block-padded level-0 WIDTH. The padded HEIGHT is
 *   not needed here: `halveRGBA` is told the padded height as its source height
 *   and clamps row requests itself, so this reader only has to answer "what is
 *   in row y", which for any y past `h` is the last real row.
 * @returns {(y0:number, count:number)=>Uint8Array}
 */
function makePaddedRowReader(readStrip, w, h, padW0) {
  // ONE scratch buffer, reused. halveRGBA holds the returned array only until it
  // asks for the next band, so overwriting in place is safe and keeps this from
  // churning ~14 MB per band through the GC.
  let scratch = null;
  return (y0, count) => {
    const need = count * padW0 * 4;
    if (scratch === null || scratch.length < need) scratch = new Uint8Array(need);
    const realRows = Math.max(0, Math.min(count, h - y0));
    if (realRows > 0) {
      const band = readStrip(y0, realRows);
      for (let r = 0; r < realRows; r++) {
        const dstRow = r * padW0 * 4;
        scratch.set(band.subarray(r * w * 4, (r + 1) * w * 4), dstRow);
        const lastCol = dstRow + (w - 1) * 4;
        for (let x = w; x < padW0; x++) {
          const d = dstRow + x * 4;
          scratch[d] = scratch[lastCol];
          scratch[d + 1] = scratch[lastCol + 1];
          scratch[d + 2] = scratch[lastCol + 2];
          scratch[d + 3] = scratch[lastCol + 3];
        }
      }
    }
    if (realRows < count) {
      // Rows past the image. Normally the band still contains real rows to clamp
      // from (padH0 - h <= 3 while bands are STRIP_ROWS deep); the fallback
      // re-reads the last real row for the degenerate tiny-image case.
      let srcRow;
      if (realRows > 0) {
        srcRow = (realRows - 1) * padW0 * 4;
      } else {
        const tail = readStrip(h - 1, 1);
        scratch.set(tail.subarray(0, w * 4), 0);
        const lastCol = (w - 1) * 4;
        for (let x = w; x < padW0; x++) {
          const d = x * 4;
          scratch[d] = scratch[lastCol];
          scratch[d + 1] = scratch[lastCol + 1];
          scratch[d + 2] = scratch[lastCol + 2];
          scratch[d + 3] = scratch[lastCol + 3];
        }
        srcRow = 0;
      }
      for (let r = Math.max(realRows, 1); r < count; r++) {
        scratch.copyWithin(r * padW0 * 4, srcRow, srcRow + padW0 * 4);
      }
    }
    return scratch.subarray(0, need);
  };
}

/** A band reader over an already-resident level buffer. */
function levelRowReader(level) {
  return (y0, count) => level.data.subarray(y0 * level.width * 4, (y0 + count) * level.width * 4);
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
  if (cached && isSameResource(cached, await headSource(src))) {
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
  const etag = resp.headers.get('etag');
  const lastModified = resp.headers.get('last-modified');
  const contentLength = resp.headers.get('content-length');
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

  await cachePut(key, { width, height, gridW, gridH, grid, etag, lastModified, contentLength }).catch(() => {});
  return { width, height, gridW, gridH, grid, cached: false };
}

async function handle(src) {
  const key = `bc:v${CACHE_VERSION}:${src}`;
  const cached = await cacheGet(key).catch(() => null);
  if (cached && isSameResource(cached, await headSource(src))) {
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
  const etag = resp.headers.get('etag');
  const lastModified = resp.headers.get('last-modified');
  const contentLength = resp.headers.get('content-length');
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

  // CASCADE — level i reduced from level i-1, not re-reduced from the source.
  // The old filter went back to the source every time to avoid compounding blur.
  // That is a real concern for repeated BILINEAR halving; it is not one for a
  // windowed sinc, and it is incompatible with an explicit kernel anyway: a
  // direct 16x reduction needs a vertical kernel spanning the whole image, which
  // for a 6750² floor means holding ~182 MB at once. A halve always spans 8
  // source rows, so every step stays banded. Peak here is one held level (~46 MB
  // for the first) plus one band (~14 MB) — well inside the memory discipline
  // keyhole-device-loss-large-map exists to protect.
  let prev = null;
  for (let i = 1; i < dims.length; i++) {
    const d = dims[i];
    prev =
      prev === null
        ? halveRGBA(makePaddedRowReader(readStrip, w, h, padW0), padW0, padH0, { bandRows: STRIP_ROWS })
        : halveRGBA(levelRowReader(prev), prev.width, prev.height, { bandRows: prev.height });
    // FAIL LOUD on a size disagreement rather than shipping a chain the GPU will
    // reinterpret at its own allocated sizes. Both sides descend by >>1 from
    // padW0/padH0 so this cannot drift today — which is precisely why a silent
    // future divergence would be so expensive to find.
    if (prev.width !== d.logicalWidth || prev.height !== d.logicalHeight) {
      throw new Error(
        `mip level ${i} size drift: reduced ${prev.width}x${prev.height}, chain expects ${d.logicalWidth}x${d.logicalHeight}`
      );
    }
    const levelBlocks = encodeStriped(levelRowReader(prev), d.logicalWidth, d.logicalHeight, format, STRIP_ROWS);
    levels.push({ width: d.width, height: d.height, blocks: levelBlocks.buffer });
  }
  bmp.close();

  // Store the levels (IndexedDB structuredClones every buffer, so the
  // originals stay valid to transfer to the main thread afterwards).
  await cachePut(key, { format, width: w, height: h, levels, alphaStats, etag, lastModified, contentLength }).catch(
    () => {}
  );
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
