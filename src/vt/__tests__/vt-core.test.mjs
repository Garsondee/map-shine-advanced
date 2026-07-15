/**
 * Node verification for the Keyhole page-cache core (Keyhole Stage 1):
 * PageCache (fixed-budget bookkeeping + LRU + pins), PageTable (indirection),
 * residency (analytic visible-page computation). No WebGL, no Foundry.
 */
import { PageCache } from '../page-cache.js';
import { PageTable, DEFAULT_PAGE_PAYLOAD_PX } from '../page-table.js';
import { computeVisiblePages, chooseMip, planResidency, coarsePinSet, diffResidency } from '../residency.js';

export function run(t) {
  const { ok, throws } = t;

  // --- PageTable: anchor against Keyhole.md's own stated number -----------
  {
    const table = new PageTable({ id: 'floor0:albedo', worldSizePx: 12000 });
    ok('table: 12000/248 world = 49x49 pages at mip0 (Keyhole.md §4.1 exact figure)', table.pagesPerAxis(0) === 49);
    ok(
      'table: payload defaults to 248 (256px page - 4px border x2)',
      table.payloadPx === DEFAULT_PAGE_PAYLOAD_PX && DEFAULT_PAGE_PAYLOAD_PX === 248
    );
    // mip chain: 49 -> 25 -> 13 -> 7 -> 4 -> 2 -> 1 (each step ceil(n/2))
    ok('table: mip chain shrinks to a single top page', table.pagesPerAxis(table.maxMip) === 1);
    ok('table: mip1 halves (ceil(49/2)=25)', table.pagesPerAxis(1) === 25);
  }

  // --- PageTable: key identity + clamping + coarse fallback ---------------
  {
    const table = new PageTable({ id: 'floor1:surfaceResponse', worldSizePx: 12000 });
    ok('table: pageKey is stable + prefixed by id', table.pageKey(0, 3, 4) === 'floor1:surfaceResponse|m0|3,4');
    const [cx, cy] = table.clampPage(0, 999, -5);
    ok('table: clampPage clamps into [0, n-1]', cx === 48 && cy === 0);

    table.setSlot(2, 1, 1, 7);
    const found = table.finestResident(0, 4, 4); // no mip0/mip1 entry -> walks up to mip2
    ok('table: finestResident walks up to the coarser resident mip', found && found.mip === 2 && found.slot === 7);
    ok(
      'table: finestResident returns null when nothing is resident anywhere',
      table.finestResident(0, 40, 40) === null
    );
  }

  // --- PageCache: THE core guarantee — capacity never grows ---------------
  {
    const cache = new PageCache({ budgetBytes: 16 * 256 * 1024 }); // 16 pages, tiny on purpose
    ok('cache: capacity computed from budget/pageBytes', cache.capacityPages === 16);
    for (let i = 0; i < 5000; i++) cache.request(`stress:${i}`, { pin: null });
    const stats = cache.stats();
    ok(
      'cache: 5000 distinct requests against a 16-page budget NEVER exceeds capacity',
      stats.residentPages <= 16 && stats.freePages >= 0
    );
    ok('cache: eviction actually happened (proves it recycled, not silently dropped)', stats.evictions > 0);
  }

  // --- PageCache: LRU evicts the least-recently-used UNPINNED slot --------
  {
    const cache = new PageCache({ budgetBytes: 3 * 256 * 1024 }); // 3 pages
    cache.tick();
    cache.request('a');
    cache.tick();
    cache.request('b');
    cache.tick();
    cache.request('c');
    // cache full: a(t0), b(t1), c(t2). Touch 'a' so 'b' becomes the LRU victim.
    cache.tick();
    cache.request('a');
    cache.tick();
    const res = cache.request('d');
    ok('cache: LRU evicts "b" (the untouched least-recent), not "a" or "c"', res.evictedKey === 'b');
    ok('cache: "a" survived (it was touched)', cache.isResident('a'));
    ok('cache: "c" survived (newer than b)', cache.isResident('c'));
    ok('cache: "d" is now resident', cache.isResident('d'));
  }

  // --- PageCache: pin classes are never evicted while pinned --------------
  {
    const cache = new PageCache({ budgetBytes: 2 * 256 * 1024 }); // 2 pages
    cache.tick();
    cache.request('coarseA', { pin: 'coarse' });
    cache.tick();
    cache.request('viewB', { pin: 'view' });
    // Cache is full and BOTH slots are pinned — a request for a third key must
    // miss cleanly, never throw, never evict a pinned page.
    const res = cache.request('c');
    ok(
      'cache: request when all slots pinned is a clean miss, not a throw',
      res.resident === false && res.slot === null
    );
    ok('cache: coarse pin survived total pressure', cache.isResident('coarseA'));
    ok('cache: view pin survived total pressure', cache.isResident('viewB'));

    // Unpin the view page — NOW it's plain LRU-evictable (still resident
    // until something actually needs the slot — unpin never evicts by itself).
    cache.unpin('viewB');
    ok('cache: unpin does not itself evict', cache.isResident('viewB'));
    const res2 = cache.request('c');
    ok(
      'cache: after unpin, the previously-view-pinned slot is now evictable',
      res2.resident === true && res2.evictedKey === 'viewB'
    );
    ok('cache: coarse pin STILL survives (only the unpinned one was ever at risk)', cache.isResident('coarseA'));
  }

  // --- PageCache: construction guards ---------------------------------------
  {
    throws('cache: rejects zero/negative budget', () => new PageCache({ budgetBytes: 0 }));
  }

  // --- residency: computeVisiblePages basic range + guard ring ------------
  {
    const table = new PageTable({ id: 'floor0:albedo', worldSizePx: 12000 }); // payload 248, 49x49 @ mip0
    // A rect covering exactly page (10,10)'s world span, page-aligned.
    const span = table.payloadPx;
    const rect = { minX: 10 * span, minY: 10 * span, maxX: 10 * span + 1, maxY: 10 * span + 1 };
    const noGuard = computeVisiblePages(table, rect, { mip: 0, guardPages: 0 });
    ok(
      'residency: a single-page rect with no guard yields exactly 1 page',
      noGuard.length === 1 && noGuard[0].px === 10 && noGuard[0].py === 10
    );

    const withGuard = computeVisiblePages(table, rect, { mip: 0, guardPages: 1 });
    ok('residency: guardPages:1 expands to the full 3x3 ring (9 pages)', withGuard.length === 9);
  }

  // --- residency: clamps to grid bounds at world edges (no negative/OOB) ---
  {
    const table = new PageTable({ id: 'floor0:albedo', worldSizePx: 12000 });
    const cornerRect = { minX: -500, minY: -500, maxX: 10, maxY: 10 };
    const pages = computeVisiblePages(table, cornerRect, { mip: 0, guardPages: 2 });
    ok(
      'residency: near-origin rect clamps to px/py >= 0 (no negative page coords)',
      pages.every((p) => p.px >= 0 && p.py >= 0)
    );

    const farCornerRect = { minX: 11999990, minY: 11999990, maxX: 12000000, maxY: 12000000 };
    const pages2 = computeVisiblePages(table, farCornerRect, { mip: 0, guardPages: 2 });
    const n = table.pagesPerAxis(0);
    ok(
      'residency: far-edge rect clamps to px/py <= n-1 (no OOB page coords)',
      pages2.every((p) => p.px <= n - 1 && p.py <= n - 1)
    );
  }

  // --- residency: chooseMip picks finer detail for a tighter zoom ---------
  {
    const table = new PageTable({ id: 'floor0:albedo', worldSizePx: 12000 });
    const wideRect = { minX: 0, minY: 0, maxX: 12000, maxY: 12000 }; // whole world visible
    const tightRect = { minX: 0, minY: 0, maxX: 500, maxY: 500 }; // zoomed way in
    const viewportPx = 1920;
    const wideMip = chooseMip(table, wideRect, viewportPx);
    const tightMip = chooseMip(table, tightRect, viewportPx);
    ok('residency: zoomed-out (whole 12000 world in 1920px) picks a coarser mip than zoomed-in', wideMip > tightMip);
    ok('residency: zoomed-in-tight-enough-for-1:1 picks mip 0', tightMip === 0);
  }

  // --- residency: planResidency bundles fine + coarser prefetch -----------
  {
    const table = new PageTable({ id: 'floor0:albedo', worldSizePx: 12000 });
    const rect = { minX: 0, minY: 0, maxX: 12000, maxY: 12000 };
    const plan = planResidency(table, rect, 1920, { guardPages: 1 });
    ok(
      'residency: planResidency returns a mip + fine set + coarser prefetch set',
      typeof plan.mip === 'number' && Array.isArray(plan.fine) && Array.isArray(plan.prefetchCoarser)
    );
    ok(
      'residency: prefetch set uses a coarser (>=) mip than fine',
      plan.prefetchCoarser.length === 0 || plan.prefetchCoarser[0].mip > plan.fine[0].mip
    );
  }

  // --- residency: coarsePinSet covers the WHOLE top mip, "tens of pages" ---
  {
    const table = new PageTable({ id: 'floor0:albedo', worldSizePx: 12000 });
    const pins = coarsePinSet(table);
    const n = table.pagesPerAxis(table.maxMip);
    ok('residency: coarsePinSet size == topMip pages^2', pins.length === n * n);
    ok('residency: coarsePinSet really is "tens of pages", not hundreds', pins.length < 100);
  }

  // --- residency: diffResidency (the pan-viewer's per-frame update) --------
  {
    const prev = new Set(['a', 'b', 'c']);
    const next = [{ key: 'b' }, { key: 'c' }, { key: 'd' }, { key: 'd' }]; // 'd' duplicated on purpose
    const diff = diffResidency(prev, next);
    ok('diffResidency: newly-needed pages are requested', diff.toRequest.length === 1 && diff.toRequest[0].key === 'd');
    ok('diffResidency: de-dupes the requested list', diff.toRequest.length === 1); // not 2, despite 'd' appearing twice
    ok('diffResidency: no-longer-needed pages are unpinned', diff.toUnpin.length === 1 && diff.toUnpin[0] === 'a');
    ok(
      'diffResidency: still-needed pages are neither requested nor unpinned',
      !diff.toRequest.some((p) => p.key === 'b' || p.key === 'c') &&
        !diff.toUnpin.includes('b') &&
        !diff.toUnpin.includes('c')
    );
    ok(
      'diffResidency: nextKeys matches the new set exactly',
      diff.nextKeys.size === 3 && diff.nextKeys.has('b') && diff.nextKeys.has('c') && diff.nextKeys.has('d')
    );
  }

  // --- residency: diffResidency on an empty transition (no churn) ----------
  {
    const prev = new Set(['x', 'y']);
    const diff = diffResidency(prev, [{ key: 'x' }, { key: 'y' }]);
    ok(
      'diffResidency: identical prev/next produces zero churn',
      diff.toRequest.length === 0 && diff.toUnpin.length === 0
    );
  }
}
