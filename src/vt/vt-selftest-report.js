/**
 * @fileoverview vt/vt-selftest-report.js — a debug-panel report that exercises
 * the vt/ pure-logic core in the REAL browser JS engine for the first time
 * (everything so far was only Node-verified), cross-checked against the same
 * numbers the Node test suite asserts.
 *
 * Deliberately does NOT construct a real `PageAtlas` (no `THREE.DataArrayTexture`
 * GPU allocation) — this report can be clicked repeatedly during a debugging
 * session and must never leak GPU memory. The atlas gets its first real
 * exercise once Stage 1 wires an actual render pass.
 *
 * @module vt/vt-selftest-report
 */

import { PageCache } from './page-cache.js';
import { PageTable } from './page-table.js';
import { computeVisiblePages, chooseMip, coarsePinSet } from './residency.js';
import { computeAtlasLayout, slotToAtlasPosition } from './atlas.js';

export function runVtSelfTest() {
  const checks = [];
  const check = (name, cond, detail) => checks.push({ name, pass: !!cond, detail });

  // Atlas layout math (Keyhole Q2 default: 512 MB @ 8 GB tier).
  const layout = computeAtlasLayout({ budgetBytes: 512 * 1024 * 1024 });
  check(
    'atlas layout: 4096px / 16x16 per layer / 8 layers / 2048 pages (Keyhole.md §4.1 exact figures)',
    layout.atlasSizePx === 4096 && layout.pagesPerAxis === 16 && layout.layers === 8 && layout.capacityPages === 2048,
    layout
  );

  const pos0 = slotToAtlasPosition(0, layout);
  const posLast = slotToAtlasPosition(layout.capacityPages - 1, layout);
  check('slot 0 -> (0,0,layer0)', pos0.x === 0 && pos0.y === 0 && pos0.layer === 0, pos0);
  check('last slot -> last layer', posLast.layer === layout.layers - 1, posLast);

  // PageTable against the torture scene's actual world size.
  const table = new PageTable({ id: 'selftest:floor0', worldWidthPx: 12000, worldHeightPx: 12000 });
  check(
    '12000px world -> 49x49 pages at mip0 (Keyhole.md §4.1 exact figure)',
    table.pagesX(0) === 49 && table.pagesY(0) === 49,
    {
      pagesAtMip0: { x: table.pagesX(0), y: table.pagesY(0) },
    }
  );

  // Residency against a plausible mid-zoom view rect.
  const rect = { minX: 4000, minY: 4000, maxX: 8000, maxY: 8000 };
  const mip = chooseMip(table, rect, 1920);
  const pages = computeVisiblePages(table, rect, { mip, guardPages: 1 });
  check(
    'residency query returns a sane, bounded page set',
    pages.length > 0 && pages.length < table.pagesX(0) * table.pagesY(0),
    { mip, pageCount: pages.length }
  );

  const pins = coarsePinSet(table);
  check('coarse pin set is "tens of pages" (Keyhole.md §4.1)', pins.length > 0 && pins.length < 100, {
    coarsePinCount: pins.length,
  });

  // PageCache: fixed capacity holds under real pressure.
  const cache = new PageCache({ budgetBytes: 32 * 256 * 1024 }); // 32-page budget, fast in-browser
  for (let i = 0; i < 500; i++) cache.request(`selftest:${i}`);
  const stats = cache.stats();
  check('PageCache capacity held under 500 requests vs a 32-page budget', stats.residentPages <= 32, stats);

  const allPassed = checks.every((c) => c.pass);
  return {
    allPassed,
    passCount: checks.filter((c) => c.pass).length,
    totalChecks: checks.length,
    checks,
    note:
      'Exercises the pure-logic vt/ core (page-cache, page-table, residency, atlas layout math) in the real ' +
      'browser JS engine. Does NOT allocate a real GPU atlas texture (PageAtlas/DataArrayTexture) — that ' +
      'only happens once Stage 1 wires a real render pass, to avoid this report leaking GPU memory if clicked repeatedly.',
  };
}
