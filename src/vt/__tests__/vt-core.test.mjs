/**
 * Node verification for the Keyhole page-cache core (Keyhole Stage 1):
 * PageCache (fixed-budget bookkeeping + LRU + pins), PageTable (indirection),
 * residency (analytic visible-page computation). No WebGL, no Foundry.
 */
import { PageCache } from '../page-cache.js';
import { PageTable, DEFAULT_PAGE_PAYLOAD_PX, computeIndirectionAtlasLayout } from '../page-table.js';
import {
  computeVisiblePages,
  chooseMip,
  chooseMipFraction,
  planResidency,
  coarsePinSet,
  coarseTopMipsForCap,
  diffResidency,
} from '../residency.js';

export function run(t) {
  const { ok, throws } = t;

  // --- PageTable: anchor against Keyhole.md's own stated number -----------
  {
    const table = new PageTable({ id: 'floor0:albedo', worldWidthPx: 12000, worldHeightPx: 12000 });
    ok('table: 12000/248 world = 49x49 pages at mip0 (Keyhole.md §4.1 exact figure)', table.pagesX(0) === 49);
    ok(
      'table: payload defaults to 248 (256px page - 4px border x2)',
      table.payloadPx === DEFAULT_PAGE_PAYLOAD_PX && DEFAULT_PAGE_PAYLOAD_PX === 248
    );
    // mip chain: 49 -> 25 -> 13 -> 7 -> 4 -> 2 -> 1 (each step ceil(n/2))
    ok('table: mip chain shrinks to a single top page', table.pagesX(table.maxMip) === 1);
    ok('table: mip1 halves (ceil(49/2)=25)', table.pagesX(1) === 25);
  }

  // --- PageTable: key identity + clamping + coarse fallback ---------------
  {
    const table = new PageTable({ id: 'floor1:surfaceResponse', worldWidthPx: 12000, worldHeightPx: 12000 });
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

  // --- PageCache: 'coarse' and 'view' pins are equally protected (real live
  // bug, 2026-07-16: a whole-screen MAGENTA render under the multi-floor
  // "castle courtyard" test — 3 floors' worth of coarse pins + view pins all
  // competing for one shared cache). Root cause: coarse and view pins are
  // BOTH permanently protected from LRU eviction (page-cache.js's own
  // _findLRUEvictable skips ANY pinned slot, no priority between classes) —
  // so if group A's view-tier request (large, numerous) runs BEFORE group B's
  // coarse-pin request (small, but meant to be GUARANTEED), group A's pins can
  // fill the cache and leave group B's coarse-pin request with nothing to
  // evict. A coarse pin whose whole job is "always something resident, worst
  // case blur" then simply FAILS for group B — the exact mechanism the
  // magenta screen exposed. This test proves the FIX'S invariant at the
  // PageCache level (independent of vt-pan-viewer.js's browser-only ordering
  // fix): if EVERY group's coarse pins are requested BEFORE any group's view
  // pins, all coarse pins survive regardless of how oversubscribed the
  // view-tier requests are afterward. -----------------------------------
  {
    const GROUPS = 3;
    const COARSE_PER_GROUP = 20;
    const VIEW_PER_GROUP = 500; // deliberately oversubscribed — 3*500=1500 >> remaining capacity
    const cache = new PageCache({ budgetBytes: 100 * 256 * 1024 }); // 100 pages
    cache.tick();

    // Phase 1 (the fix): coarse pins for EVERY group, before ANY view request.
    for (let g = 0; g < GROUPS; g++) {
      for (let i = 0; i < COARSE_PER_GROUP; i++) cache.request(`g${g}:coarse:${i}`, { pin: 'coarse' });
    }
    const coarseResidentAfterPhase1 = Array.from({ length: GROUPS * COARSE_PER_GROUP }, (_, i) =>
      cache.isResident(`g${Math.floor(i / COARSE_PER_GROUP)}:coarse:${i % COARSE_PER_GROUP}`)
    ).every(Boolean);
    ok("phase1: every group's coarse pins land while the cache still has room", coarseResidentAfterPhase1);

    // Phase 2: now oversubscribe view-tier requests across all groups (the
    // real castle-scenario shape — far more view pages requested than remain).
    for (let g = 0; g < GROUPS; g++) {
      for (let i = 0; i < VIEW_PER_GROUP; i++) cache.request(`g${g}:view:${i}`, { pin: 'view' });
    }

    let coarseSurvived = 0;
    for (let g = 0; g < GROUPS; g++)
      for (let i = 0; i < COARSE_PER_GROUP; i++) if (cache.isResident(`g${g}:coarse:${i}`)) coarseSurvived++;
    ok(
      'phase-1-then-phase-2 ordering: EVERY coarse pin survives massive view-tier oversubscription afterward',
      coarseSurvived === GROUPS * COARSE_PER_GROUP
    );
    ok(
      'view-tier oversubscription genuinely caused misses (proves the test scenario is real pressure)',
      cache.stats().misses > 0
    );
  }

  // --- PageCache: the BROKEN ordering (coarse mixed AFTER an earlier group's
  // view pins) CAN starve a later group's coarse pins — proves the bug was
  // real, not hypothetical, at the PageCache level (the layer BOTH the old
  // buggy code and the new fixed code share).
  {
    const cache = new PageCache({ budgetBytes: 100 * 256 * 1024 }); // 100 pages
    cache.tick();
    // Group A: coarse (20) then view (500, oversubscribed) — the OLD per-group order.
    for (let i = 0; i < 20; i++) cache.request(`a:coarse:${i}`, { pin: 'coarse' });
    for (let i = 0; i < 500; i++) cache.request(`a:view:${i}`, { pin: 'view' }); // fills the remaining 80 slots, all protected
    // Group B's coarse pins now have NOTHING evictable to claim a slot from.
    let bCoarseSucceeded = 0;
    for (let i = 0; i < 20; i++) {
      const { resident } = cache.request(`b:coarse:${i}`, { pin: 'coarse' });
      if (resident) bCoarseSucceeded++;
    }
    ok(
      "the OLD per-group order CAN starve a later group's coarse pins (confirms the bug mechanism was real)",
      bCoarseSucceeded < 20
    );
  }

  // --- PageCache + diffResidency: the "stuck view-miss" bug (real live find,
  // 2026-07-16 — a residency report showed layerResidencyTotals.viewResidentPages
  // (tracked) far exceeding cacheStats.pinnedView (ground truth): 2604 vs 1161).
  // Root cause in vt-pan-viewer.js's streamPackResidency: it used to assign
  // `pack.residentViewKeys = diff.nextKeys` unconditionally — the FULL
  // requested set — regardless of whether each `cache.request()` call actually
  // succeeded. A page that missed (cache full) got recorded as "resident"
  // anyway, so on every LATER update `diffResidency(prevKeys, nextPages)` saw
  // it as already-handled (present in prevKeys) and never re-added it to
  // toRequest — permanently stuck on coarse-fallback blur for as long as the
  // camera kept needing it, even after pressure relieved. Rendering itself was
  // never wrong (writeIndirection independently checks real cache residency),
  // just unnecessarily and permanently blurry. This test reproduces the exact
  // pattern with PageCache + diffResidency directly (the pure pieces
  // streamPackResidency composes) — proves the OLD tracking gets stuck and the
  // FIX (filter by cache.isResident before storing) self-heals once room frees up.
  {
    const cache = new PageCache({ budgetBytes: 5 * 256 * 1024 }); // 5 pages
    cache.tick();
    // A permanent blocker occupies 3 of the 5 slots, simulating other floors'
    // protected pins competing for the same shared cache.
    for (let i = 0; i < 3; i++) cache.request(`blocker:${i}`, { pin: 'coarse' });

    const needed = Array.from({ length: 4 }, (_, i) => ({ key: `p:${i}` })); // 4 wanted, only 2 slots free

    // --- OLD (buggy) tracking: residentViewKeys = the full requested set ----
    let oldPrevKeys = new Set();
    {
      const cacheOld = new PageCache({ budgetBytes: 5 * 256 * 1024 });
      cacheOld.tick();
      for (let i = 0; i < 3; i++) cacheOld.request(`blocker:${i}`, { pin: 'coarse' });
      const diff = diffResidency(oldPrevKeys, needed);
      for (const page of diff.toRequest) cacheOld.request(page.key, { pin: 'view' });
      oldPrevKeys = diff.nextKeys; // THE BUG: unconditional, ignores which requests actually missed
      // Update 2: blocker frees up (room now exists), needed set UNCHANGED.
      for (let i = 0; i < 3; i++) cacheOld.unpin(`blocker:${i}`);
      cacheOld.request(`filler:0`); // force an eviction cycle to actually reclaim the freed slots
      cacheOld.request(`filler:1`);
      cacheOld.request(`filler:2`);
      const diff2 = diffResidency(oldPrevKeys, needed);
      ok(
        'OLD tracking: a page that missed once is NEVER retried, even after room frees up (the bug, reproduced)',
        diff2.toRequest.length === 0
      );
    }

    // --- NEW (fixed) tracking: residentViewKeys = ONLY what's actually resident ----
    {
      let newPrevKeys = new Set();
      const diff = diffResidency(newPrevKeys, needed);
      for (const page of diff.toRequest) cache.request(page.key, { pin: 'view' });
      newPrevKeys = new Set([...diff.nextKeys].filter((key) => cache.isResident(key)));
      const missedFirstRound = needed.filter((p) => !newPrevKeys.has(p.key));
      ok(
        'NEW tracking: exactly the pages that missed are excluded from residentViewKeys',
        missedFirstRound.length === 2
      );

      // Update 2: room frees up, needed set unchanged — the fix should retry the missed pages.
      for (let i = 0; i < 3; i++) cache.unpin(`blocker:${i}`);
      const diff2 = diffResidency(newPrevKeys, needed);
      ok(
        'NEW tracking: previously-missed pages ARE retried once room frees up (the fix)',
        diff2.toRequest.length === missedFirstRound.length &&
          missedFirstRound.every((p) => diff2.toRequest.some((r) => r.key === p.key))
      );
      for (const page of diff2.toRequest) cache.request(page.key, { pin: 'view' });
      const allResidentNow = needed.every((p) => cache.isResident(p.key));
      ok('NEW tracking: after the retry, all 4 originally-needed pages are resident', allResidentNow);
    }
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
    const table = new PageTable({ id: 'floor0:albedo', worldWidthPx: 12000, worldHeightPx: 12000 }); // payload 248, 49x49 @ mip0
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
    const table = new PageTable({ id: 'floor0:albedo', worldWidthPx: 12000, worldHeightPx: 12000 });
    const cornerRect = { minX: -500, minY: -500, maxX: 10, maxY: 10 };
    const pages = computeVisiblePages(table, cornerRect, { mip: 0, guardPages: 2 });
    ok(
      'residency: near-origin rect clamps to px/py >= 0 (no negative page coords)',
      pages.every((p) => p.px >= 0 && p.py >= 0)
    );

    const farCornerRect = { minX: 11999990, minY: 11999990, maxX: 12000000, maxY: 12000000 };
    const pages2 = computeVisiblePages(table, farCornerRect, { mip: 0, guardPages: 2 });
    const n = table.pagesX(0);
    ok(
      'residency: far-edge rect clamps to px/py <= n-1 (no OOB page coords)',
      pages2.every((p) => p.px <= n - 1 && p.py <= n - 1)
    );
  }

  // --- residency: chooseMip picks finer detail for a tighter zoom ---------
  {
    const table = new PageTable({ id: 'floor0:albedo', worldWidthPx: 12000, worldHeightPx: 12000 });
    const wideRect = { minX: 0, minY: 0, maxX: 12000, maxY: 12000 }; // whole world visible
    const tightRect = { minX: 0, minY: 0, maxX: 500, maxY: 500 }; // zoomed way in
    const viewportPx = 1920;
    const wideMip = chooseMip(table, wideRect, viewportPx);
    const tightMip = chooseMip(table, tightRect, viewportPx);
    ok('residency: zoomed-out (whole 12000 world in 1920px) picks a coarser mip than zoomed-in', wideMip > tightMip);
    ok('residency: zoomed-in-tight-enough-for-1:1 picks mip 0', tightMip === 0);
  }

  // --- residency: chooseMipFraction — THE smooth-mip-blend invariant (real
  // author complaint, 2026-07-16: "zooming in and out produces very ugly zoom
  // levels" — the hard integer-mip pop). floor(chooseMipFraction(...)) MUST
  // equal chooseMip(...) for the SAME inputs, always — this is what lets the
  // shader blend between the two bracketing mips WITHOUT any residency/
  // streaming change: planResidency already fetches mip M (fine) and mip M+1
  // (prefetchCoarser), so as long as this invariant holds, those are exactly
  // the two mips a blend needs. Swept across a wide, deliberately-adversarial
  // range including exact power-of-2 boundaries (the classic float/int
  // rounding edge case) and the two clamp ends (mip 0 and table.maxMip).
  {
    const table = new PageTable({ id: 'floor0:albedo', worldWidthPx: 12000, worldHeightPx: 12000 });
    const viewportPx = 1920;
    // worldSpan values chosen to land texelsPerScreenPx exactly ON several
    // power-of-2 boundaries (1,2,4,8,...), plus values just above/below each,
    // plus extreme zoom-in/out. This is the exact class of value where a
    // float log2 vs. an integer doubling-loop could disagree if the two
    // formulas weren't truly equivalent.
    const worldSpans = [1, 100, 500, 960, 1919, 1920, 1921, 3840, 3841, 7680, 15360, 30720, 61440, 120000, 500000];
    let allMatch = true;
    for (const worldSpan of worldSpans) {
      const rect = { minX: 0, minY: 0, maxX: worldSpan, maxY: worldSpan };
      const discrete = chooseMip(table, rect, viewportPx);
      const fraction = chooseMipFraction(table, rect, viewportPx);
      if (Math.floor(fraction) !== discrete) allMatch = false;
    }
    ok('chooseMipFraction: floor(fraction) === chooseMip() across power-of-2 boundaries + extremes', allMatch);
    ok(
      'chooseMipFraction: always within [0, table.maxMip]',
      worldSpans.every((worldSpan) => {
        const f = chooseMipFraction(table, { minX: 0, minY: 0, maxX: worldSpan, maxY: worldSpan }, viewportPx);
        return f >= 0 && f <= table.maxMip;
      })
    );
    // The whole POINT: two zoom levels close together but straddling an
    // integer-mip threshold must produce a SMALL fractional change, not a
    // jump — this is the actual "ugly pop" the fraction exists to smooth over.
    const justBelow = chooseMipFraction(table, { minX: 0, minY: 0, maxX: 1919, maxY: 1919 }, viewportPx);
    const justAbove = chooseMipFraction(table, { minX: 0, minY: 0, maxX: 1921, maxY: 1921 }, viewportPx);
    ok(
      'chooseMipFraction: a tiny zoom change near a mip threshold produces a tiny fractional change (the actual fix)',
      Math.abs(justAbove - justBelow) < 0.01
    );
  }

  // --- residency: planResidency bundles fine + coarser prefetch -----------
  {
    const table = new PageTable({ id: 'floor0:albedo', worldWidthPx: 12000, worldHeightPx: 12000 });
    const rect = { minX: 0, minY: 0, maxX: 12000, maxY: 12000 };
    const plan = planResidency(table, rect, 1920, { guardPages: 1 });
    ok(
      'residency: planResidency returns a mip + mipFraction + fine set + coarser prefetch set',
      typeof plan.mip === 'number' &&
        typeof plan.mipFraction === 'number' &&
        Array.isArray(plan.fine) &&
        Array.isArray(plan.prefetchCoarser)
    );
    ok(
      'residency: prefetch set uses a coarser (>=) mip than fine',
      plan.prefetchCoarser.length === 0 || plan.prefetchCoarser[0].mip > plan.fine[0].mip
    );
    ok(
      'residency: planResidency.mipFraction matches chooseMipFraction directly',
      plan.mipFraction === chooseMipFraction(table, rect, 1920)
    );
    ok(
      'residency: floor(planResidency.mipFraction) === planResidency.mip (the blend invariant, end to end)',
      Math.floor(plan.mipFraction) === plan.mip
    );
  }

  // --- residency: planResidency's prefetchFiner — the zoom-IN hitch fix
  // (real author-reported bug, 2026-07-16: "zoom in or out can hitch, stops
  // happening if I repeat" — a cold-cache-on-first-visit decode stall).
  // prefetchCoarser existed alone before this; prefetchFiner is its symmetric
  // counterpart so BOTH zoom directions have an already-warm neighbor mip. ---
  {
    const table = new PageTable({ id: 'floor0:albedo', worldWidthPx: 12000, worldHeightPx: 12000 }); // maxMip = 6
    // A mid-zoom rect (not fully zoomed in, not fully out) so plan.mip lands
    // strictly between 0 and table.maxMip — the case where BOTH neighbors
    // exist. texelsPerScreenPx = 2000/200 = 10 -> mip 3 (hand-verified: the
    // coverage-doubling loop crosses 1,2,4,8 before 8*2=16 exceeds 10).
    const midRect = { minX: 0, minY: 0, maxX: 2000, maxY: 2000 };
    const plan = planResidency(table, midRect, 200, { guardPages: 1 });
    ok('residency: planResidency returns a prefetchFiner array', Array.isArray(plan.prefetchFiner));
    // Anchor: fail LOUDLY if this ever lands outside (0, maxMip) — the
    // conditional checks below would otherwise silently stop exercising
    // (exactly how the FIRST version of this test accidentally passed with
    // its branches never actually running — computed to mip 0, hand-fixed).
    ok(
      'residency: mid-zoom rect anchor really does land strictly between mip 0 and maxMip',
      plan.mip > 0 && plan.mip < table.maxMip
    );
    if (plan.mip > 0) {
      ok(
        'residency: prefetchFiner uses a FINER (<) mip than fine, when a finer mip exists',
        plan.prefetchFiner.length > 0 && plan.prefetchFiner[0].mip < plan.mip
      );
      ok('residency: prefetchFiner is exactly one mip level finer', plan.prefetchFiner[0].mip === plan.mip - 1);
    }

    // At mip 0 (fully zoomed in — no finer mip exists), prefetchFiner must be
    // empty, never negative-mip garbage.
    const tightRect = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const tightPlan = planResidency(table, tightRect, 1920, { guardPages: 1 });
    ok(
      'residency: at mip 0, prefetchFiner is empty (no finer mip exists, never negative)',
      tightPlan.mip === 0 && tightPlan.prefetchFiner.length === 0
    );

    // Symmetric coverage check: BOTH prefetch directions present for a true
    // mid-zoom (this is the actual fix — the shader/user experience is only
    // solved when both exist together, not just one).
    if (plan.mip > 0 && plan.mip < table.maxMip) {
      ok(
        'residency: mid-zoom has BOTH prefetchCoarser AND prefetchFiner non-empty (symmetric insurance)',
        plan.prefetchCoarser.length > 0 && plan.prefetchFiner.length > 0
      );
    }
  }

  // --- residency: coarsePinSet covers the WHOLE top mip, "tens of pages" ---
  {
    const table = new PageTable({ id: 'floor0:albedo', worldWidthPx: 12000, worldHeightPx: 12000 });
    const pins = coarsePinSet(table);
    const n = table.pagesX(table.maxMip);
    ok('residency: coarsePinSet default (topMips:1) size == topMip pages^2', pins.length === n * n && n === 1);
    ok('residency: coarsePinSet really is "tens of pages", not hundreds', pins.length < 100);
  }

  // --- residency: coarsePinSet with topMips pins the coarsest N levels -----
  {
    const table = new PageTable({ id: 'floor0:albedo', worldWidthPx: 12000, worldHeightPx: 12000 });
    // mip page counts from the top: mip6=1, mip5=4, mip4=16, mip3=49
    const pins3 = coarsePinSet(table, { topMips: 3 });
    ok('residency: coarsePinSet topMips:3 covers mips maxMip..maxMip-2 (1+4+16=21)', pins3.length === 1 + 4 + 16);
    const mips = new Set(pins3.map((p) => p.mip));
    ok(
      'residency: topMips:3 spans exactly the three coarsest mip levels',
      mips.size === 3 && mips.has(table.maxMip) && mips.has(table.maxMip - 2) && !mips.has(table.maxMip - 3)
    );
    ok(
      'residency: coarse pages carry mip + key (so the viewer can pin + index them)',
      pins3.every((p) => typeof p.mip === 'number' && typeof p.key === 'string')
    );
    // Every coarse page has a DISTINCT key (no accidental collisions across mips).
    ok('residency: all coarse-pin keys are distinct', new Set(pins3.map((p) => p.key)).size === pins3.length);
  }

  // --- residency: coarseTopMipsForCap keeps the pinned set within the cap --
  {
    const table = new PageTable({ id: 'floor0:albedo', worldWidthPx: 12000, worldHeightPx: 12000 });
    // Cap 96: 1+4+16=21 (<=96), +49=70 (<=96), +169=239 (>96) -> stop at 4 levels.
    const n4 = coarseTopMipsForCap(table, { maxPages: 96 });
    ok('residency: coarseTopMipsForCap(96) pins 4 levels (1+4+16+49=70 <= 96)', n4 === 4);
    const total = coarsePinSet(table, { topMips: n4 }).length;
    ok('residency: the chosen depth actually fits under the cap', total <= 96 && total === 70);
    // A tiny cap still returns at least 1 (the top page is non-negotiable).
    ok(
      'residency: coarseTopMipsForCap always pins at least the top page',
      coarseTopMipsForCap(table, { maxPages: 0 }) >= 1
    );
    // A huge cap pins every mip level.
    ok(
      'residency: a cap larger than the whole pyramid pins all levels',
      coarseTopMipsForCap(table, { maxPages: 1e9 }) === table.maxMip + 1
    );
  }

  // --- page-table: flattened-pyramid indirection layout -------------------
  {
    const table = new PageTable({ id: 'floor0:albedo', worldWidthPx: 12000, worldHeightPx: 12000 });
    const lay = computeIndirectionAtlasLayout(table);
    // page chain 49,25,13,7,4,2,1 -> width 49, height 49+25+13+7+4+2+1=101
    ok('indirection: width == mip0 pagesX (49)', lay.width === 49);
    ok('indirection: height == sum of all mips pagesY (101)', lay.height === 101);
    ok('indirection: mipCount == maxMip+1', lay.mipCount === table.maxMip + 1);
    ok(
      'indirection: mip0 origin is (0,0), 49x49 pages',
      lay.origins[0].x === 0 && lay.origins[0].y === 0 && lay.origins[0].pagesX === 49 && lay.origins[0].pagesY === 49
    );
    ok(
      'indirection: mip1 origin stacks directly below mip0 (y=49), 25x25 pages',
      lay.origins[1].x === 0 && lay.origins[1].y === 49 && lay.origins[1].pagesX === 25 && lay.origins[1].pagesY === 25
    );
    ok(
      'indirection: top mip is a single page at the bottom row',
      lay.origins[table.maxMip].pagesX === 1 && lay.origins[table.maxMip].pagesY === 1
    );
    // Every mip's grid fits inside the packed texture bounds (no overflow).
    ok(
      'indirection: every mip grid fits within width x height',
      lay.origins.every((o) => o.x + o.pagesX <= lay.width && o.y + o.pagesY <= lay.height)
    );
  }

  // --- page-table: RECTANGULAR sources (2026-07-16) ------------------------
  {
    // The case that used to throw at the caller and blocked BOTH tiles and every
    // non-square scene. A 4000x3000 image: independent page counts per axis.
    const table = new PageTable({ id: 'level0:bg', worldWidthPx: 4000, worldHeightPx: 3000 });
    ok('rect: pagesX = ceil(4000/248) = 17', table.pagesX(0) === 17);
    ok('rect: pagesY = ceil(3000/248) = 13', table.pagesY(0) === 13);
    ok('rect: axes halve independently at mip1 (9x7)', table.pagesX(1) === 9 && table.pagesY(1) === 7);
    ok(
      'rect: chain bottoms out at a single page on BOTH axes',
      table.pagesX(table.maxMip) === 1 && table.pagesY(table.maxMip) === 1
    );
    const lay = computeIndirectionAtlasLayout(table);
    ok('rect: indirection width is mip0 pagesX (17)', lay.width === 17);
    // The mip chain runs until BOTH axes reach 1, so the SHORTER axis bottoms
    // out early and is then PADDED with 1s while the longer axis keeps halving:
    //   X: 17, 9, 5, 3, 2, 1   (6 levels — X is longer, so it sets maxMip = 5)
    //   Y: 13, 7, 4, 2, 1, 1   (6 levels — the trailing 1 is padding, not a bug)
    // Height therefore sums SIX Y entries (28), not the five the Y chain would
    // have on its own. Worth an explicit test: the padded tail is exactly the
    // sort of off-by-one that would silently overflow the indirection texture.
    ok('rect: indirection height sums the padded Y chain (13+7+4+2+1+1=28)', lay.height === 28);
    ok('rect: both mip chains are the same length', table.maxMip === 5 && lay.origins.length === 6);
    ok('rect: the short axis is padded with 1s, not truncated', table.pagesY(5) === 1 && table.pagesX(5) === 1);
    ok(
      'rect: every mip grid still fits the packed texture',
      lay.origins.every((o) => o.x + o.pagesX <= lay.width && o.y + o.pagesY <= lay.height)
    );
  }

  // --- page-table: EXTREMELY oblong source (the long-axis tail) ------------
  {
    // A banner-shaped tile: the short axis bottoms out at 1 page long before the
    // long axis does. The mip chain must keep halving the long axis rather than
    // stopping as soon as EITHER axis reaches 1 — otherwise the top mip is not a
    // single page and the coarse-pin "whole image always resident" guarantee
    // (the thing that makes a miss mean blur instead of magenta) quietly breaks.
    const table = new PageTable({ id: 'tile:banner', worldWidthPx: 8000, worldHeightPx: 256 });
    ok(
      'oblong: pagesX = ceil(8000/248) = 33, pagesY = ceil(256/248) = 2',
      table.pagesX(0) === 33 && table.pagesY(0) === 2
    );
    ok(
      'oblong: top mip IS a single page on both axes',
      table.pagesX(table.maxMip) === 1 && table.pagesY(table.maxMip) === 1
    );
    ok(
      'oblong: short axis pins at 1 and stays there while the long axis keeps halving',
      table.pagesY(2) === 1 && table.pagesX(2) === 9
    );
    // maxMip is driven by the LONG axis: 33,17,9,5,3,2,1 -> 6
    ok('oblong: maxMip is driven by the long axis (6)', table.maxMip === 6);
  }

  // --- page-table: a square table is just a rectangle -----------------------
  {
    const table = new PageTable({ id: 'sq', worldWidthPx: 12000, worldHeightPx: 12000 });
    ok(
      'square: pagesX === pagesY at every mip',
      Array.from({ length: table.maxMip + 1 }, (_, m) => m).every((m) => table.pagesX(m) === table.pagesY(m))
    );
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
