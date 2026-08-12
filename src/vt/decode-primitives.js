/**
 * @fileoverview vt/decode-primitives.js — the fully pure half of decode-pool.js:
 * byte-level image-header parsing, page-geometry math, URL normalization, a
 * streaming byte reader, and a generic counting semaphore. NONE of this
 * touches decode-pool's stateful caches (_sourceCache/_sliceHeld/_decodeStats)
 * or its worker — which is exactly why it is Node-testable while the rest of
 * that file is not, and why it moved out on 2026-07-25 (the size-ratchet
 * god-object reversal): decode-pool.js was a 1,128-line file with no single
 * offending function, just accumulated bulk, and this is its pure third.
 *
 * decode-pool.js imports everything here for its own internal use, and
 * re-exports `pageWorldRect`/`DEFAULT_BORDER_PX` specifically because
 * decode-pool.worker.js and vt-live-decode-report.js already import those two
 * from that path — nothing else here had an external consumer beyond
 * decode-pool.js itself, so nothing else needed a compatibility re-export.
 *
 * @module vt/decode-primitives
 */

/** Default border width in texels (Keyhole Q1: 256px page - 248 payload = 4px/side). */
export const DEFAULT_BORDER_PX = 4;

/**
 * Pure: has enough wall-clock time elapsed since the last yield that we
 * should yield again NOW? TIME-based, not a fixed page count (2026-07-16
 * refinement — the original per-6-pages count still let a real ~358ms freeze
 * through, confirmed live via the zoom-thrash-test tool: a handful of COARSE-
 * mip pages — each requiring a large single-step downsample crop, inherently
 * much more expensive than an ordinary fine-mip page's near-1:1 resize — can
 * each individually cost tens of ms, so even 6 of them back-to-back still
 * exceeded a user-perceptible stall). A FIXED page count can't distinguish
 * "6 cheap pages" from "6 expensive pages"; a time budget caps the worst case
 * regardless of what makes any individual page slow, AND doesn't penalize
 * bulk-loading many cheap fine-mip pages with needless yield overhead (a real
 * regression risk considered and rejected — yielding every single page
 * regardless of cost would slow ordinary coarse-pin loading, which decodes
 * many pages at once, for no benefit on the pages that are already fast).
 * @param {number} elapsedMsSinceLastYield @param {number} maxMsPerChunk
 * @returns {boolean}
 */
export function shouldYieldByTime(elapsedMsSinceLastYield, maxMsPerChunk) {
  return elapsedMsSinceLastYield >= maxMsPerChunk;
}

/**
 * Pure: the world-space rect (in this virtual texture's mip-0 world units) a
 * page's ATLAS SLOT covers, payload + border, clamped to the world bounds.
 * This is what the decode step crops from the source image — border texels
 * come from the real neighboring source pixels (not synthesized padding),
 * which is what makes seams disappear at page boundaries.
 *
 * @param {import('./page-table.js').PageTable} table
 * @param {number} mip @param {number} px @param {number} py
 * @param {object} [opts] @param {number} [opts.borderPx]
 * @returns {{minX:number,minY:number,maxX:number,maxY:number, unclamped:{minX:number,minY:number,maxX:number,maxY:number}}}
 */
export function pageWorldRect(table, mip, px, py, opts = {}) {
  const borderPx = opts.borderPx ?? DEFAULT_BORDER_PX;
  const payloadSpan = table.payloadPx * (1 << mip);
  const borderSpan = borderPx * (1 << mip);

  const x0 = px * payloadSpan - borderSpan;
  const y0 = py * payloadSpan - borderSpan;
  const x1 = (px + 1) * payloadSpan + borderSpan;
  const y1 = (py + 1) * payloadSpan + borderSpan;

  return {
    minX: Math.max(0, x0),
    minY: Math.max(0, y0),
    // Per-axis clamp (rectangular sources, 2026-07-16) — a tile's texture or a
    // non-square scene background has independent extents, so a single
    // world-size bound would let one axis read past the source image.
    maxX: Math.min(table.worldWidthPx, x1),
    maxY: Math.min(table.worldHeightPx, y1),
    unclamped: { minX: x0, minY: y0, maxX: x1, maxY: y1 },
  };
}

/**
 * Pure: where a page's REAL (clamped, world-bounds-respecting) crop should
 * land within a `pageSizePx`-square output, and its scaled size there — given
 * both the clamped rect (what's actually available to sample) and the
 * unclamped nominal rect (this page's full, un-truncated world-space span,
 * always exactly `pageSizePx * 2^mip` wide/tall — see `pageWorldRect`).
 *
 * WHY THIS EXISTS (author-reported live bug, 2026-07-15, real 12000² mansion
 * art: "strangeness around the right and bottom edges" — the torture fixture's
 * regular labeled grid made the same artifact much less noticeable). The
 * ORIGINAL `decodePage` cropped only the CLAMPED rect and resized THAT up to a
 * full `pageSizePx` square. For any page whose nominal span crosses a world
 * edge — which is EVERY page along the world's last row/column whenever
 * worldSizePx isn't an exact multiple of the page payload (12000/248 isn't:
 * the last page's real content is only ~100 of 256 nominal texels — hand-
 * verified in decode-pool.test.mjs's own "page(0,48,48)" case), and even
 * page (0,0) by the 4px border alone — that naive resize non-uniformly
 * STRETCHES real image content by up to ~2.56x. The fix: place the real crop
 * at its TRUE relative position/size within the output (no stretch beyond
 * what the mip's own zoom factor already implies) and clamp-extend (repeat
 * the nearest real edge pixel) into the genuinely-missing region — there ARE
 * no source pixels there, so synthesizing padding beats distorting real ones.
 *
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} clamped
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} unclamped
 * @param {number} pageSizePx
 * @returns {{dx:number,dy:number,dw:number,dh:number,needsPadding:boolean}}
 */
export function computePagePlacement(clamped, unclamped, pageSizePx) {
  const fullSpanX = unclamped.maxX - unclamped.minX;
  const fullSpanY = unclamped.maxY - unclamped.minY;
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const dx = clampInt(Math.round(((clamped.minX - unclamped.minX) / fullSpanX) * pageSizePx), 0, pageSizePx - 1);
  const dy = clampInt(Math.round(((clamped.minY - unclamped.minY) / fullSpanY) * pageSizePx), 0, pageSizePx - 1);
  // dw/dh's upper bound is `pageSizePx - dx/dy` (not a bare pageSizePx clamp)
  // so independent rounding of dx and dw can never let dx+dw exceed pageSizePx
  // — that would otherwise hand the padding math a negative width below.
  const dw = clampInt(Math.round(((clamped.maxX - clamped.minX) / fullSpanX) * pageSizePx), 1, pageSizePx - dx);
  const dh = clampInt(Math.round(((clamped.maxY - clamped.minY) / fullSpanY) * pageSizePx), 1, pageSizePx - dy);

  const needsPadding = dx > 0 || dy > 0 || dx + dw < pageSizePx || dy + dh < pageSizePx;
  return { dx, dy, dw, dh, needsPadding };
}

/**
 * A minimal counting semaphore. `acquire()` resolves when a slot is free;
 * `release()` frees one and wakes the next waiter. Correct FIFO ordering (a
 * pushed resolver is only invoked when a slot is actually available).
 * @param {number} max
 */
export function createSemaphore(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length > 0) {
      active++;
      queue.shift()();
    }
  };
  return {
    acquire() {
      return new Promise((resolve) => {
        queue.push(resolve);
        pump();
      });
    },
    release() {
      active = Math.max(0, active - 1);
      pump();
    },
    stats() {
      return { active, waiting: queue.length, max };
    },
  };
}

/**
 * Read {width,height} from the LEADING HEADER BYTES of a PNG or WebP file —
 * pure, no decode, Node-testable. Both formats carry their dimensions at fixed
 * offsets near the start, so a ~30-byte read is all it takes. Returns null when
 * the bytes are not a recognized/complete header (caller must fall back to an
 * actual decode).
 *
 * WHY WEBP IS NOT OPTIONAL (2026-07-17, device-loss investigation on the
 * 12000² mansion): the original code understood ONLY PNG (`0x89504E47` +
 * IHDR). Every real Level/mask asset in these scenes is WebP, so the cheap
 * header path failed 100% of the time and fell through to `getSourceDimensions`'s
 * decode fallback — a FULL 144-megapixel source decode JUST to learn a
 * width/height. Off-thread when it could route to the worker, but that worker
 * is SERIAL (one job at a time) and each such decode ran ~2.2s
 * (`maxSourceAcquireMs`), so a floor's worth of packs backed the worker up for
 * seconds and forced actual page-slices onto the MAIN THREAD (the 749ms
 * `maxSinglePageMs` stalls in the live report). It also made
 * `rangedFetchMisses` a LIAR — it counted every WebP as "the server didn't
 * honor Range" when the real cause was "the parser only knew PNG"
 * ([[feedback_instruments_must_not_lie]]).
 *
 * WebP layout: 'RIFF'(0-3) <size>(4-7) 'WEBP'(8-11) then one of three chunks —
 * 'VP8 ' lossy (14-bit w@26/h@28 LE, low 14 bits), 'VP8L' lossless (0x2f sig
 * @20 then 14-bit w-1/h-1 packed LE @21), 'VP8X' extended (24-bit canvas w-1
 * @24 / h-1 @27 LE). See the WebP container spec.
 *
 * @param {Uint8Array} bytes - at least the first ~30 bytes of the file.
 * @returns {{width:number, height:number}|null}
 */
export function parseImageDimensions(bytes) {
  if (!bytes || bytes.byteLength < 24) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: signature 0x89504E47 at 0; IHDR width@16 / height@20 (big-endian).
  if (dv.getUint32(0) === 0x89504e47) {
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // WebP: 'RIFF' at 0, 'WEBP' at 8, then a VP8/VP8L/VP8X chunk fourCC at 12.
  if (dv.getUint32(0) === 0x52494646 && dv.getUint32(8) === 0x57454250) {
    const fourCC = dv.getUint32(12);
    if (fourCC === 0x56503820 /* 'VP8 ' lossy */) {
      if (bytes.byteLength < 30) return null;
      return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    }
    if (fourCC === 0x5650384c /* 'VP8L' lossless */) {
      if (bytes.byteLength < 25 || dv.getUint8(20) !== 0x2f) return null;
      const packed = dv.getUint32(21, true);
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
    if (fourCC === 0x56503858 /* 'VP8X' extended */) {
      if (bytes.byteLength < 30) return null;
      const w = dv.getUint8(24) | (dv.getUint8(25) << 8) | (dv.getUint8(26) << 16);
      const h = dv.getUint8(27) | (dv.getUint8(28) << 8) | (dv.getUint8(29) << 16);
      return { width: w + 1, height: h + 1 };
    }
  }
  return null;
}

/**
 * Normalize an asset URL to the ROOT-ABSOLUTE form ("/modules/…") the rest of
 * MSA already uses for Level art. Pure, idempotent, Node-testable.
 *
 * WHY (2026-07-17, the 12000² mansion device-loss hunt — a DIRECT cause of the
 * main-thread giant decodes, not just cosmetic): `FilePicker.browse()` (the
 * mask discovery lister) returns data-relative paths with NO leading slash
 * ("modules/mythica-machina-mansion/assets/…_Outdoors.webp"). The main thread
 * resolves those against the document at /game and they fetch fine — but the
 * decode WORKER's own script URL is /modules/map-shine-advanced/src/vt/…, so a
 * bare "modules/…" there resolves to
 * /modules/map-shine-advanced/src/vt/modules/… → HTTP 404. The worker slice
 * then fails, `acquirePages` falls back to `acquireSliceSource` ON THE MAIN
 * THREAD, where the same relative URL DOES resolve → a full 144-megapixel mask
 * decode lands on the render thread (the ~2.9s `maxSourceAcquireMs` stall).
 * A leading slash makes the path resolve against the ORIGIN in BOTH contexts,
 * matching the albedo's own "/modules/…" form (which is why the albedo never
 * hit this). It is a PURE STRING transform applied at each decode entry point
 * BEFORE both the fetch AND the page-store key, so the worker and main thread
 * never disagree on a key — no IndexedDB cache desync. Already-absolute URLs
 * (http(s)://, protocol-relative //, data:, blob:) pass through untouched, as
 * do paths that already lead with "/".
 *
 * NOTE: this deliberately mirrors the albedo's existing "/modules/…"
 * convention rather than resolving a Foundry route prefix — a routed install
 * (`/foundry/game`) would need the SAME systemic treatment for the albedo too,
 * which is a separate change; this scene, like the albedo, is at the origin root.
 * @param {string} url @returns {string}
 */
export function toRootAbsoluteAssetUrl(url) {
  if (typeof url !== 'string' || url === '') return url;
  if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(url) || /^(data|blob):/i.test(url)) return url;
  return url.startsWith('/') ? url : `/${url}`;
}

/**
 * Read only the first `n` bytes of a Response's body via its stream, then
 * cancel the rest — the point being to never pay for what a full
 * `res.arrayBuffer()` would cost when the server ignored our Range header and
 * sent the whole file. Environments without a streaming body (rare; every
 * real browser target has one) fall back to a full read, bounded reasoning
 * unchanged: this only ever needs the leading bytes either way.
 * @param {Response} res @param {number} n @returns {Promise<Uint8Array>}
 */
export async function readLeadingBytes(res, n) {
  if (!res.body?.getReader) return new Uint8Array(await res.arrayBuffer()).subarray(0, n);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < n) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch (_) {
      /* the connection may already be closed — cancelling it is a courtesy, not a requirement */
    }
  }
  const out = new Uint8Array(Math.min(total, n));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, out.byteLength - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= out.byteLength) break;
  }
  return out;
}

/**
 * Pure reducer for one pinned source's release lifecycle (`decode-pool.js`'s
 * `_sourceCache`). A pinned bitmap can be released (`releaseSourceBitmap`,
 * added so a scene MSA leaves behind doesn't keep its full-resolution source
 * ImageBitmap resident forever — see decode-pool.js's own header) WHILE
 * `acquireSliceSource`'s pinned fast path is still actively reading it
 * (page-streaming for the scene the user is in the middle of leaving, still
 * draining). Closing the bitmap out from under that in-flight read would
 * throw on its next `drawImage` call — a real race, not a theoretical one,
 * since eviction is driven by `canvasInit` firing for the NEXT scene, which
 * has no way to know whether the OUTGOING scene's residency system has fully
 * quiesced.
 *
 * The fix mirrors `_sliceHeld`'s existing ring-managed refcounting elsewhere
 * in decode-pool.js (`releaseSliceSource`'s `refs<=0` check) — same shape,
 * applied to the previously-unmanaged pinned cache: a release request while
 * `refs > 0` is deferred (`pendingRelease:true`) rather than acted on
 * immediately, and whichever `release` action drains the last ref performs it.
 *
 * @typedef {{refs: number, pendingRelease: boolean}} PinRefState
 * @param {PinRefState} state
 * @param {'acquire'|'release'|'evict'} action - 'acquire'/'release' bracket one
 *   pinned-fast-path read; 'evict' is a `releaseSourceBitmap(url)` request.
 * @returns {{state: PinRefState, shouldClose: boolean}} `shouldClose:true` means
 *   the caller must close the bitmap and drop it from `_sourceCache` now.
 */
export function reducePinRefState(state, action) {
  if (action === 'acquire') {
    return { state: { refs: state.refs + 1, pendingRelease: state.pendingRelease }, shouldClose: false };
  }
  if (action === 'release') {
    const refs = Math.max(0, state.refs - 1);
    if (refs === 0 && state.pendingRelease) return { state: { refs: 0, pendingRelease: false }, shouldClose: true };
    return { state: { refs, pendingRelease: state.pendingRelease }, shouldClose: false };
  }
  // 'evict'
  if (state.refs > 0) return { state: { refs: state.refs, pendingRelease: true }, shouldClose: false };
  return { state: { refs: 0, pendingRelease: false }, shouldClose: true };
}

/** The state a URL starts in before any pinned-path acquire or evict request. */
export const INITIAL_PIN_REF_STATE = Object.freeze({ refs: 0, pendingRelease: false });

/** Test seam: the pure semaphore, exported for Node verification. @private */
export const __createSemaphore = createSemaphore;

/**
 * Test seam: `readLeadingBytes` needs only a Response-shaped object with a
 * `.body.getReader()` (or none, for the fallback branch) — no real `fetch`
 * required — so its byte-assembly math (the part most likely to hide an
 * off-by-one) is genuinely Node-testable, unlike the rest of this file.
 * @private
 */
export const __readLeadingBytes = readLeadingBytes;
