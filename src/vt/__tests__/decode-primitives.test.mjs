/**
 * Node verification for vt/decode-primitives.js — decode-pool.js's pure half
 * (split out 2026-07-25, the size-ratchet god-object reversal). decode-pool.js
 * itself now has no Node-testable part left: getSourceBitmap/decodePage use
 * fetch/createImageBitmap (browser-only) -- verified live via the debug
 * panel's "VT Live Decode Test" report instead.
 */
import { PageTable } from '../page-table.js';
import {
  pageWorldRect,
  DEFAULT_BORDER_PX,
  computePagePlacement,
  __createSemaphore,
  shouldYieldByTime,
  __readLeadingBytes,
  parseImageDimensions,
  toRootAbsoluteAssetUrl,
} from '../decode-primitives.js';

export async function run(t) {
  const { ok } = t;

  ok('DEFAULT_BORDER_PX is 4 (256px page - 248 payload, split both sides)', DEFAULT_BORDER_PX === 4);

  // --- slice-source semaphore: the decode-memory bound -----------------------
  // The concurrency cap on held full source bitmaps is what keeps peak decode
  // memory O(ring), not O(layers×floors). Verify it NEVER lets more than `max`
  // run at once even under a burst of concurrent acquirers.
  {
    const MAX = 3;
    const sem = __createSemaphore(MAX);
    let active = 0;
    let peak = 0;
    const tick = () => new Promise((r) => setTimeout(r, 1));
    const task = async () => {
      await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await tick(); // hold the slot across an async boundary (like a real decode)
      active--;
      sem.release();
    };
    await Promise.all(Array.from({ length: 12 }, () => task()));
    ok('semaphore: peak concurrency never exceeds max (the decode-memory bound)', peak <= MAX && peak > 0);
    ok(
      'semaphore: all acquirers drain to zero active + zero waiting',
      sem.stats().active === 0 && sem.stats().waiting === 0
    );
  }

  // --- shouldYieldByTime: the decode-burst cooperative-yield budget (real
  // live bug, 2026-07-16 — a zoom-thrash-test report showed the FIRST fix (a
  // fixed page-count cadence) still let a real ~358ms freeze through: a
  // handful of COARSE-mip pages, each individually expensive — a large
  // single-step downsample crop — blew straight through a "yield every 6
  // pages" budget, since 6 EXPENSIVE pages can still take far longer than 6
  // cheap ones. Time-based yielding caps the worst case regardless of what
  // makes any individual page slow, without needlessly penalizing bulk-
  // loading many CHEAP fine-mip pages (the original per-count design's
  // rejected alternative — yield every single page — would have done exactly
  // that: real yield overhead on pages that were never the problem). -------
  {
    const BUDGET = 10;
    ok('shouldYieldByTime: does not yield before the budget elapses', shouldYieldByTime(5, BUDGET) === false);
    ok('shouldYieldByTime: yields exactly AT the budget', shouldYieldByTime(10, BUDGET) === true);
    ok('shouldYieldByTime: yields well past the budget too', shouldYieldByTime(358, BUDGET) === true);
    ok('shouldYieldByTime: zero elapsed never yields', shouldYieldByTime(0, BUDGET) === false);

    // THE actual bug this replaces: simulate "6 pages, each costing 80ms" (a
    // realistic coarse-mip decode cost, per the live thrash-test report's
    // ~358ms/13-page incident) under the OLD fixed-count design vs the NEW
    // time-based one — the old design would let all 6 pages (480ms) run
    // before ever checking anything past "is this the 6th item"; the new one
    // must yield far sooner, well before accumulating anywhere near that.
    {
      const EXPENSIVE_PAGE_MS = 80;
      let elapsedSinceYield = 0;
      let yieldCount = 0;
      let maxUninterruptedMs = 0;
      for (let page = 0; page < 6; page++) {
        elapsedSinceYield += EXPENSIVE_PAGE_MS;
        maxUninterruptedMs = Math.max(maxUninterruptedMs, elapsedSinceYield);
        if (shouldYieldByTime(elapsedSinceYield, BUDGET)) {
          yieldCount++;
          elapsedSinceYield = 0;
        }
      }
      ok(
        'shouldYieldByTime: 6 EXPENSIVE pages yield after almost every one (caps the worst case) — the actual fix',
        yieldCount >= 5
      );
      ok(
        'shouldYieldByTime: max uninterrupted stretch stays close to ONE expensive page, never accumulates to 6x',
        maxUninterruptedMs < EXPENSIVE_PAGE_MS * 2
      );
    }

    // The other half of the fix's justification: many CHEAP pages should NOT
    // yield constantly (avoiding needless overhead during bulk coarse-pin loading).
    {
      const CHEAP_PAGE_MS = 1;
      let elapsedSinceYield = 0;
      let yieldCount = 0;
      for (let page = 0; page < 40; page++) {
        elapsedSinceYield += CHEAP_PAGE_MS;
        if (shouldYieldByTime(elapsedSinceYield, BUDGET)) {
          yieldCount++;
          elapsedSinceYield = 0;
        }
      }
      ok(
        'shouldYieldByTime: 40 CHEAP pages yield only a handful of times, not on every page',
        yieldCount > 0 && yieldCount < 10
      );
    }
  }

  // --- torture-scene world (12000px, payload 248, 49x49 @ mip0) -----------
  const table = new PageTable({ id: 'floor0:albedo', worldWidthPx: 12000, worldHeightPx: 12000 });

  // First page: unclamped would start at -4 (border overshoots world origin)
  // -> clamped to 0. This is exactly the "seam at the world edge" case.
  {
    const r = pageWorldRect(table, 0, 0, 0);
    ok('page(0,0,0): unclamped minX is -borderPx (overshoots origin)', r.unclamped.minX === -DEFAULT_BORDER_PX);
    ok('page(0,0,0): clamped minX/minY pinned to 0 (never negative)', r.minX === 0 && r.minY === 0);
    ok(
      'page(0,0,0): maxX/maxY = payload(248) + border(4) = 252 (not clamped, well inside world)',
      r.maxX === 252 && r.maxY === 252
    );
  }

  // A middle page: fully interior, so clamped === unclamped (no edge effect).
  {
    const r = pageWorldRect(table, 0, 10, 10);
    const payloadSpan = table.payloadPx; // mip 0, so span == payloadPx
    ok(
      'page(0,10,10): interior page is unaffected by clamping',
      r.minX === r.unclamped.minX && r.maxX === r.unclamped.maxX
    );
    ok('page(0,10,10): minX = 10*248 - 4', r.minX === 10 * payloadSpan - DEFAULT_BORDER_PX);
    ok('page(0,10,10): maxX = 11*248 + 4', r.maxX === 11 * payloadSpan + DEFAULT_BORDER_PX);
  }

  // Last page on the axis (px=48, the 49th of 0..48): unclamped maxX
  // overshoots the 12000px world edge -> must clamp, not read past the source.
  {
    const r = pageWorldRect(table, 0, 48, 48);
    const unclampedMax = 49 * table.payloadPx + DEFAULT_BORDER_PX; // 49*248+4 = 12156
    ok(
      'page(0,48,48): unclamped maxX overshoots the 12000px world (as expected)',
      r.unclamped.maxX === unclampedMax && unclampedMax > 12000
    );
    ok(
      'page(0,48,48): clamped maxX/maxY pinned to worldSizePx (never reads past the source image)',
      r.maxX === 12000 && r.maxY === 12000
    );
  }

  // Mip scaling: a coarser mip's border/payload span scales by 2^mip, same
  // rule computeVisiblePages() uses (pageWorldSpan = payloadPx * (1<<mip)).
  {
    const r0 = pageWorldRect(table, 0, 0, 0);
    const r1 = pageWorldRect(table, 1, 0, 0);
    ok(
      'mip1 page(0,0) covers 2x the world span of mip0 page(0,0)',
      r1.unclamped.maxX - r1.unclamped.minX === 2 * (r0.unclamped.maxX - r0.unclamped.minX)
    );
  }

  // --- computePagePlacement: the edge-stretch fix (author-reported live bug,
  // real 12000² art: "strangeness around the right and bottom edges") -------

  // Interior page: clamped === unclamped -> full-size placement, no padding.
  // The 256-square anchor test's own numbers (page(0,10,10) is interior).
  {
    const r = pageWorldRect(table, 0, 10, 10);
    const p = computePagePlacement(r, r.unclamped, 256);
    ok(
      'placement: interior page places at (0,0) full 256x256',
      p.dx === 0 && p.dy === 0 && p.dw === 256 && p.dh === 256
    );
    ok('placement: interior page needs no padding', p.needsPadding === false);
  }

  // Page (0,0,0): left/top border clamped by exactly 4px (hand-derived above:
  // unclamped minX=-4, clamped minX=0, fullSpan=256) -> the real crop is
  // 252/256 of the page, offset 4px in from the left/top.
  {
    const r = pageWorldRect(table, 0, 0, 0);
    const p = computePagePlacement(r, r.unclamped, 256);
    ok('placement: page(0,0) offsets 4px in from the left/top (border clamp)', p.dx === 4 && p.dy === 4);
    ok('placement: page(0,0) real content is 252px wide/tall (256 - 4px border)', p.dw === 252 && p.dh === 252);
    ok('placement: page(0,0) needs padding (the 4px border strip)', p.needsPadding === true);
  }

  // Page (0,48,48): the world's LAST page on both axes (hand-derived above:
  // unclamped maxX=12156, clamped maxX=12000, fullSpan=256, real width=100)
  // -> THE case that used to get stretched ~2.56x (256/100) before this fix.
  {
    const r = pageWorldRect(table, 0, 48, 48);
    const p = computePagePlacement(r, r.unclamped, 256);
    ok('placement: page(48,48) real content starts at (0,0) (left/top not clamped)', p.dx === 0 && p.dy === 0);
    ok(
      'placement: page(48,48) real content is exactly 100px (the actual un-stretched crop width — the bug this fixes)',
      p.dw === 100 && p.dh === 100
    );
    ok('placement: page(48,48) needs padding (156px of no-source-data past the world edge)', p.needsPadding === true);
  }

  // Placement never overflows the page bounds, even under independent
  // rounding of dx/dw (the reason dw's clamp uses `pageSizePx - dx` as its
  // upper bound, not a bare `pageSizePx`).
  {
    // A deliberately awkward fraction (world edge at a position that rounds
    // dx and dw in a way that could naively overflow without the fix).
    const clamped = { minX: 100, minY: 0, maxX: 254, maxY: 200 };
    const unclamped = { minX: 100, minY: 0, maxX: 356, maxY: 200 }; // fullSpan 256
    const p = computePagePlacement(clamped, unclamped, 256);
    ok('placement: dx+dw never exceeds pageSizePx', p.dx + p.dw <= 256);
    ok('placement: dy+dh never exceeds pageSizePx', p.dy + p.dh <= 256);
    ok('placement: dw/dh are always at least 1 (never zero/negative)', p.dw >= 1 && p.dh >= 1);
  }

  // --- readLeadingBytes: avoid a full-file download for a 24-byte PNG header
  // (found 2026-07-17, the freeze investigation). If the asset server ignores
  // our Range request and answers 200 with the WHOLE file, the old code
  // (`res.arrayBuffer()`) buffered the entire response before reading even
  // one byte — for this project's own scale (a Level background can be
  // hundreds of MB), that is a real, serious cost, not a theory. This reads
  // ONLY what's needed and CANCELS the rest of the stream. A fake
  // Response-shaped object is enough here — no real `fetch` needed, which is
  // what makes this pure math genuinely Node-testable despite living in an
  // otherwise browser-only file. -------------------------------------------
  {
    /** A fake streaming Response body: yields the given chunks, then done. Tracks whether cancel() was called. */
    function makeStreamingResponse(chunks) {
      let i = 0;
      let cancelled = false;
      return {
        cancelled: () => cancelled,
        body: {
          getReader() {
            return {
              async read() {
                if (i >= chunks.length) return { done: true, value: undefined };
                return { done: false, value: chunks[i++] };
              },
              async cancel() {
                cancelled = true;
              },
            };
          },
        },
      };
    }

    // Exactly enough, in ONE chunk.
    {
      const res = makeStreamingResponse([new Uint8Array([1, 2, 3, 4, 5])]);
      const out = await __readLeadingBytes(res, 5);
      ok('readLeadingBytes: single chunk, exact length', out.length === 5 && out[0] === 1 && out[4] === 5);
    }

    // Split across MULTIPLE chunks, boundary falling mid-chunk — the case
    // most likely to hide an off-by-one in the assembly loop.
    {
      const res = makeStreamingResponse([
        new Uint8Array([10, 20, 30]),
        new Uint8Array([40, 50, 60, 70]),
        new Uint8Array([80, 90]),
      ]);
      const out = await __readLeadingBytes(res, 5);
      ok(
        'readLeadingBytes: assembles across a chunk boundary correctly, in order',
        out.length === 5 && Array.from(out).join(',') === '10,20,30,40,50'
      );
    }

    // MORE bytes available than requested — must truncate, not over-read.
    {
      const res = makeStreamingResponse([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])]);
      const out = await __readLeadingBytes(res, 3);
      ok('readLeadingBytes: truncates to exactly n, even when more is available', out.length === 3);
    }

    // FEWER bytes available than requested (a genuinely tiny/truncated file)
    // — must return what exists, never throw, never pad with garbage.
    {
      const res = makeStreamingResponse([new Uint8Array([1, 2])]);
      const out = await __readLeadingBytes(res, 24);
      ok(
        'readLeadingBytes: fewer bytes available than requested returns exactly what exists, no throw',
        out.length === 2 && out[0] === 1 && out[1] === 2
      );
    }

    // THE POINT OF THE WHOLE FIX: the stream is CANCELLED once enough bytes
    // are read, not drained to completion — proven by a chunk that would only
    // be consumed if reading continued past what was needed.
    {
      let readCallsAfterSatisfied = 0;
      const chunks = [new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array([6, 7, 8])];
      let i = 0;
      let cancelled = false;
      const res = {
        body: {
          getReader() {
            return {
              async read() {
                if (i >= chunks.length) {
                  readCallsAfterSatisfied++; // would only happen if the loop kept pulling
                  return { done: true, value: undefined };
                }
                return { done: false, value: chunks[i++] };
              },
              async cancel() {
                cancelled = true;
              },
            };
          },
        },
      };
      await __readLeadingBytes(res, 5); // exactly satisfied by the FIRST chunk
      ok('readLeadingBytes: stops reading as soon as n bytes are available (does not pull the second chunk)', i === 1);
      ok('readLeadingBytes: cancels the stream rather than draining it — this IS the fix', cancelled === true);
      ok('readLeadingBytes: never called read() again after being satisfied', readCallsAfterSatisfied === 0);
    }

    // Environments with no streaming body (rare) fall back to a full read —
    // must still work, must still truncate to n.
    {
      const res = { body: null, arrayBuffer: async () => new Uint8Array([9, 8, 7, 6, 5]).buffer };
      const out = await __readLeadingBytes(res, 3);
      ok('readLeadingBytes: falls back to arrayBuffer() when no streaming body exists', out.length === 3);
    }
  }

  // --- parseImageDimensions: read {w,h} from header bytes, NO decode (found
  // 2026-07-17, the 12000² mansion device-loss hunt). The original code knew
  // ONLY PNG, so every WebP asset in these scenes failed the cheap header read
  // and fell through to a full 144-megapixel decode JUST to learn width/height
  // — clogging the serial decode worker and spilling page-slices onto the main
  // thread (the 749ms stalls before device loss). It also made
  // `rangedFetchMisses` lie (counting every WebP as "server ignored Range").
  // These build REAL headers for each format and prove round-trip w/h, using
  // ASYMMETRIC dimensions (12000×8000) so any width/height swap is caught. ---
  {
    // PNG: sig 0x89504E47 @0; IHDR width@16 / height@20, big-endian.
    function makePng(width, height) {
      const b = new Uint8Array(24);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, 0x89504e47);
      dv.setUint32(16, width); // big-endian by default
      dv.setUint32(20, height);
      return b;
    }
    // Shared WebP container prefix: 'RIFF'@0, 'WEBP'@8, chunk fourCC@12.
    function makeWebpBase(fourCC, len) {
      const b = new Uint8Array(len);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, 0x52494646); // 'RIFF'
      dv.setUint32(8, 0x57454250); // 'WEBP'
      dv.setUint32(12, fourCC);
      return { b, dv };
    }
    function makeVp8Lossy(width, height) {
      const { b, dv } = makeWebpBase(0x56503820, 30); // 'VP8 '
      dv.setUint16(26, width & 0x3fff, true); // 14-bit LE
      dv.setUint16(28, height & 0x3fff, true);
      return b;
    }
    function makeVp8Lossless(width, height) {
      const { b, dv } = makeWebpBase(0x5650384c, 25); // 'VP8L'
      dv.setUint8(20, 0x2f); // required VP8L signature byte
      const packed = (((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)) >>> 0;
      dv.setUint32(21, packed, true);
      return b;
    }
    function makeVp8x(width, height) {
      const { b, dv } = makeWebpBase(0x56503858, 30); // 'VP8X'
      const w = width - 1;
      const h = height - 1;
      dv.setUint8(24, w & 0xff);
      dv.setUint8(25, (w >>> 8) & 0xff);
      dv.setUint8(26, (w >>> 16) & 0xff);
      dv.setUint8(27, h & 0xff);
      dv.setUint8(28, (h >>> 8) & 0xff);
      dv.setUint8(29, (h >>> 16) & 0xff);
      return b;
    }

    const W = 12000;
    const H = 8000;

    {
      const d = parseImageDimensions(makePng(W, H));
      ok('parseImageDimensions: PNG reads width/height from IHDR (big-endian)', d && d.width === W && d.height === H);
    }
    {
      const d = parseImageDimensions(makeVp8Lossy(W, H));
      ok('parseImageDimensions: WebP VP8 (lossy) reads 14-bit LE width/height', d && d.width === W && d.height === H);
    }
    {
      const d = parseImageDimensions(makeVp8Lossless(W, H));
      ok(
        'parseImageDimensions: WebP VP8L (lossless) unpacks width-1/height-1 from the bitstream',
        d && d.width === W && d.height === H
      );
    }
    {
      const d = parseImageDimensions(makeVp8x(W, H));
      ok(
        'parseImageDimensions: WebP VP8X (extended) reads 24-bit LE canvas width-1/height-1',
        d && d.width === W && d.height === H
      );
    }

    // Rejection cases — every one MUST fall back to a real decode (return null),
    // never guess. A silent wrong-size here would corrupt page math worldwide.
    {
      ok('parseImageDimensions: null/too-short input returns null', parseImageDimensions(null) === null);
      ok(
        'parseImageDimensions: fewer than 24 bytes returns null (never reads past the buffer)',
        parseImageDimensions(new Uint8Array(10)) === null
      );
      ok(
        'parseImageDimensions: unknown signature (all zero) returns null',
        parseImageDimensions(new Uint8Array(30)) === null
      );
      // 'RIFF'/'WEBP' present but only 24 bytes — a VP8 header needs 30. Must
      // NOT read past the buffer and MUST return null (fall back to decode).
      {
        const truncated = makeVp8Lossy(W, H).slice(0, 24);
        ok(
          'parseImageDimensions: truncated WebP VP8 header (24 of 30 bytes) returns null',
          parseImageDimensions(truncated) === null
        );
      }
      // 'RIFF'/'WEBP' with an unrecognized chunk fourCC — return null, not junk.
      {
        const { b } = makeWebpBase(0x41414141, 30); // 'AAAA'
        ok('parseImageDimensions: WebP with unknown chunk fourCC returns null', parseImageDimensions(b) === null);
      }
    }

    // A small asymmetric case for each format, guarding the +1 / mask math at
    // the low end (where an off-by-one is easiest to miss).
    {
      ok(
        'parseImageDimensions: VP8L small case 3×7 round-trips (width-1/height-1 +1 math)',
        (() => {
          const d = parseImageDimensions(makeVp8Lossless(3, 7));
          return d && d.width === 3 && d.height === 7;
        })()
      );
      ok(
        'parseImageDimensions: VP8X small case 3×7 round-trips',
        (() => {
          const d = parseImageDimensions(makeVp8x(3, 7));
          return d && d.width === 3 && d.height === 7;
        })()
      );
    }
  }

  // --- toRootAbsoluteAssetUrl: the mansion mask 404 (2026-07-17). FilePicker
  // .browse() lists data-relative paths ("modules/…") that fetch fine on the
  // main thread but 404 inside the decode WORKER (whose base is
  // /modules/map-shine-advanced/src/vt/), forcing the giant mask decode back
  // onto the main thread. A leading slash resolves against the ORIGIN in both
  // contexts. Pure string transform, so it is applied before BOTH the fetch and
  // the page-store key (no IndexedDB desync) — these lock that contract in. ---
  {
    ok(
      'toRootAbsoluteAssetUrl: bare data-relative mask path gains a leading slash (THE bug)',
      toRootAbsoluteAssetUrl('modules/mythica-machina-mansion/assets/ground_floor_150_Outdoors.webp') ===
        '/modules/mythica-machina-mansion/assets/ground_floor_150_Outdoors.webp'
    );
    ok(
      'toRootAbsoluteAssetUrl: already-root-absolute albedo path is unchanged (no cache invalidation)',
      toRootAbsoluteAssetUrl('/modules/mythica-machina-mansion/assets/ground_floor_150.webp') ===
        '/modules/mythica-machina-mansion/assets/ground_floor_150.webp'
    );
    ok(
      'toRootAbsoluteAssetUrl: is idempotent (applying twice equals applying once — safe at every entry point)',
      toRootAbsoluteAssetUrl(toRootAbsoluteAssetUrl('modules/a/b.webp')) === toRootAbsoluteAssetUrl('modules/a/b.webp')
    );
    ok(
      'toRootAbsoluteAssetUrl: preserves a query string while still prefixing',
      toRootAbsoluteAssetUrl('modules/a/b.webp?v=2') === '/modules/a/b.webp?v=2'
    );
    // Already-absolute forms MUST pass through untouched (Forge CDN, S3, inline).
    ok(
      'toRootAbsoluteAssetUrl: https:// URL passes through untouched',
      toRootAbsoluteAssetUrl('https://cdn.example.com/x_Outdoors.webp') === 'https://cdn.example.com/x_Outdoors.webp'
    );
    ok(
      'toRootAbsoluteAssetUrl: http:// URL passes through untouched',
      toRootAbsoluteAssetUrl('http://cdn.example.com/x.webp') === 'http://cdn.example.com/x.webp'
    );
    ok(
      'toRootAbsoluteAssetUrl: protocol-relative //host URL passes through untouched',
      toRootAbsoluteAssetUrl('//cdn.example.com/x.webp') === '//cdn.example.com/x.webp'
    );
    ok(
      'toRootAbsoluteAssetUrl: data: URL passes through untouched',
      toRootAbsoluteAssetUrl('data:image/png;base64,iVBORw0KGgo=') === 'data:image/png;base64,iVBORw0KGgo='
    );
    ok(
      'toRootAbsoluteAssetUrl: blob: URL passes through untouched',
      toRootAbsoluteAssetUrl('blob:https://mythicamachina.com/abc-123') === 'blob:https://mythicamachina.com/abc-123'
    );
    // Degenerate inputs must never throw (a decode request must survive them).
    ok('toRootAbsoluteAssetUrl: empty string returns empty string', toRootAbsoluteAssetUrl('') === '');
    ok('toRootAbsoluteAssetUrl: null returns null (no throw)', toRootAbsoluteAssetUrl(null) === null);
  }
}
