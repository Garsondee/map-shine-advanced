/**
 * Node verification for vt/decode-pool.js's pure part (pageWorldRect).
 * getSourceBitmap/decodePage use fetch/createImageBitmap (browser-only) --
 * verified live via the debug panel's "VT Live Decode Test" report instead.
 */
import { PageTable } from '../page-table.js';
import {
  pageWorldRect,
  DEFAULT_BORDER_PX,
  computePagePlacement,
  __createSemaphore,
  shouldYieldByTime,
} from '../decode-pool.js';

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
  const table = new PageTable({ id: 'floor0:albedo', worldSizePx: 12000 });

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
}
