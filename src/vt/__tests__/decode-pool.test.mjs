/**
 * Node verification for vt/decode-pool.js's pure part (pageWorldRect).
 * getSourceBitmap/decodePage use fetch/createImageBitmap (browser-only) --
 * verified live via the debug panel's "VT Live Decode Test" report instead.
 */
import { PageTable } from '../page-table.js';
import { pageWorldRect, DEFAULT_BORDER_PX } from '../decode-pool.js';

export function run(t) {
  const { ok } = t;

  ok('DEFAULT_BORDER_PX is 4 (256px page - 248 payload, split both sides)', DEFAULT_BORDER_PX === 4);

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
}
