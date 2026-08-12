/**
 * cache-report.js — THE CACHE ROW ADAPTER. Pure functions, no clock, no DOM,
 * no GPU — same discipline as `perf-report.js`, which this module feeds.
 *
 * Every cache in this codebase reports its own health in its own bespoke
 * shape (`page-cache.js`'s `{capacityPages, residentPages, ...}` looks
 * nothing like `depth-proxy-material-pool.js`'s `{hits, misses, evictions,
 * size}`, which looks nothing like `mask-authority.js`'s `{bakeRuns,
 * bakeSkips}`). This file's whole job is turning each of those into ONE
 * comparable row — `perf-instrumentation-audit-2026-08-12`'s §2B/§4 ask,
 * "everything which produces a cache, I want to specifically know how well
 * those caches are functioning."
 *
 * ============================================================================
 * WHY THIS DOES NOT ABSORB THE PRE-EXISTING PROBES
 * ============================================================================
 *
 * `depthProxyPoolStats`/`shaderRebuildStats`/`pipelineRebuildStats`/
 * `passSlotStats`/`windowDiagnostics` already have their own dedicated
 * `instrument.*` report fields, and the first three also have carefully-
 * tuned `findings[]` entries of their own (`depth-proxy-pool-health`,
 * `shader-rebuild-churn`, `pipeline-rebuild-churn`, `window-surface-
 * composition` — `perf-report.js`'s own `deriveFindings`). Re-deriving that
 * logic here risks disagreeing with it. This file MIRRORS them into
 * `caches[]` (one summary row each, pulling from the SAME already-sampled
 * data) so a reader gets one list of every cache in the system, without
 * duplicating ownership of the underlying numbers or the severity judgement
 * already made about them.
 *
 * ============================================================================
 * WHAT THIS FILE REFUSES TO DO
 * ============================================================================
 *
 * NEVER INVENT A HITS COUNTER A CACHE DOES NOT HAVE. `page-cache.js`'s own
 * stats() has no hits field at all (only `misses`/`evictions` are counters —
 * everything else is point-in-time occupancy). Reporting `hitRatePct: null`
 * with a note explaining why is the honest answer; deriving a fake one from
 * unrelated fields is exactly the class of lie `feedback_instruments_must_
 * not_lie` names. Where two counters are the closest available proxies but
 * measure different granularities (decode-pool's per-SOURCE `sourcesDecoded`
 * vs per-PAGE `idbHits`), the row says so in `note` rather than presenting a
 * precise-looking ratio that isn't.
 *
 * ============================================================================
 * THREE SPECIAL CASES (cache-completeness pass, 2026-08-12 §5F-3)
 * ============================================================================
 *
 * `graph/frame-graph.js`'s pool is DELIBERATELY ABSENT from `caches[]`, not
 * forgotten. `graph/index.js`'s own header: "Real, tested, harvested V3
 * machinery with ZERO callers... It stays internal until something real
 * calls it." Wiring it here would either read permanently null/zero forever
 * (a row that never says anything, easily mistaken for "measured and
 * healthy") or require importing machinery that file's own barrel keeps
 * deliberately unexported. When it gets a real caller, wire it then — not
 * before.
 *
 * `maskDiscovery` (foundry/mask-discovery.js) has NO ongoing hit/miss pair:
 * `listingCache`/`probeMemo` are function-LOCAL to `discoverAuthoredMasks`,
 * discarded the instant it returns — there is nothing left to poll by the
 * time a perf-run-full window opens. What IS wired is the STORED result's
 * own one-shot summary (`scene/mask-authority.js#getDiscoveryStats`, read
 * from `scene.discovery` — the persisted verdict `setDiscovery` keeps for
 * the whole session), reported as occupancy (`size`/`capacity`), not a
 * per-window rate.
 *
 * `pixiProxy` (foundry/pixi-proxy-textures.js) writes INTO Foundry's own
 * `PIXI.Assets.cache`, which this codebase does not own and cannot see
 * lookups against (that file's own header: the one fact about whether
 * `PIXI.Assets.load()` actually honours a seeded entry "can't be confirmed
 * from source alone"). The counters wired here are MSA's own write-ATTEMPT
 * outcome (did `registerPixiProxy` seed a new entry, or skip for one of
 * three distinct reasons) — never framed as a hit/miss rate against
 * Foundry's store, which would be a claim this module cannot back.
 *
 * @module diag/cache-report
 */

const round = (v, dp) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp;

/** `end - start`, or `null` if either side is missing/non-finite — a delta
 * across a window is meaningless without both endpoints, and `null` here
 * must never collapse to a misleading 0. */
function delta(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return b - a;
}

/** `hits / (hits + misses)`, or `null` when either count is unavailable or
 * both are zero (a rate over zero observations is not a rate). */
function hitRatePct(hits, misses) {
  if (!Number.isFinite(hits) || !Number.isFinite(misses)) return null;
  const total = hits + misses;
  if (total <= 0) return null;
  return round((hits / total) * 100, 1);
}

/** Build one normalized row. `size`/`capacity` are END-of-window snapshots
 * (current occupancy), never a delta — occupancy is a state, not a count of
 * events, the same distinction `perf-report.js`'s own zone rows draw between
 * a cadence's mean and its peak. */
function row({
  id,
  label,
  ownerEffectId = null,
  hits = null,
  misses = null,
  evictions = null,
  size = null,
  capacity = null,
  note = null,
}) {
  return {
    id,
    label,
    ownerEffectId,
    hits,
    misses,
    evictions,
    size,
    capacity,
    hitRatePct: hitRatePct(hits, misses),
    note,
  };
}

/** True for a harness read that reached no live viewer at all — the SAME
 * `{skipped:true, reason:...}` shape every `getVtPanViewer*` proxy export
 * returns when `_active` is null. Absent, not a zero. */
function isSkipped(v) {
  return v && v.skipped === true;
}

/** Sum one `bakeGate` counter across every floor slot in a `{floors: [...]}`
 * snapshot (sun-shadow-subsystem.js's own per-floor status array) — `null`
 * when the snapshot itself is absent, never 0 for "no snapshot" (only for
 * "snapshot present, every floor summed to zero"). */
function sumFloorBakeGateField(snapshot, field) {
  if (!snapshot || !Array.isArray(snapshot.floors)) return null;
  return snapshot.floors.reduce((acc, f) => acc + (Number.isFinite(f?.bakeGate?.[field]) ? f.bakeGate[field] : 0), 0);
}

/**
 * Adapters keyed by the SAME id `boot.js`'s `readCacheStats()` hook uses.
 * Each takes this window's (start, end) pair for that one key and returns a
 * row, or `null` when there is genuinely nothing to report (never armed,
 * viewer not started, or both endpoints absent).
 * @type {Record<string, (start: object|null, end: object|null) => object|null>}
 */
const RAW_CACHE_ADAPTERS = {
  vtPageCache(start, end) {
    if (!end || isSkipped(end)) return null;
    return row({
      id: 'vtPageCache',
      label: 'VT page cache (atlas residency)',
      misses: delta(start?.misses, end.misses),
      evictions: delta(start?.evictions, end.evictions),
      size: Number.isFinite(end.residentPages) ? end.residentPages : null,
      capacity: Number.isFinite(end.capacityPages) ? end.capacityPages : null,
      note:
        'page-cache.js exposes no hits counter (only misses/evictions are lifetime counts — everything else is ' +
        'point-in-time occupancy), so hitRatePct cannot be computed. size/capacity are the END-of-window snapshot.',
    });
  },
  vtDecodePool(start, end) {
    if (!end || isSkipped(end)) return null;
    return row({
      id: 'vtDecodePool',
      label: 'VT decode pool (source bitmap + IndexedDB)',
      hits: delta(start?.idbHits, end.idbHits),
      misses: delta(start?.sourcesDecoded, end.sourcesDecoded),
      note:
        'hits = pages served from IndexedDB without a re-decode (idbHits); misses = full SOURCE images actually ' +
        'decoded (sourcesDecoded) — different granularities (per-page vs per-source), so hitRatePct here is ' +
        'directional, not an exact per-request rate.',
    });
  },
  vegetationProxyNodeCache(start, end) {
    if (!end || isSkipped(end)) return null;
    return row({
      id: 'vegetationProxyNodeCache',
      label: 'Vegetation depth-proxy node cache (unpooled)',
      ownerEffectId: 'vegetation',
      hits: delta(start?.hits, end.hits),
      misses: delta(start?.misses, end.misses),
      note:
        'A WeakMap keyed on each overlay’s own motion bag (deliberately excluded from depth-proxy-' +
        'material-pool.js — see that file’s "WHY VEGETATION IS DELIBERATELY EXCLUDED"). No size/eviction is ' +
        'observable: entries vanish uncounted when their motion bag is garbage-collected.',
    });
  },
  maskAuthorityBakeGate(start, end) {
    if (!end || isSkipped(end)) return null;
    return row({
      id: 'maskAuthorityBakeGate',
      label: 'Mask authority bake gate (derived-mask recompute)',
      hits: delta(start?.bakeSkips, end.bakeSkips),
      misses: delta(start?.bakeRuns, end.bakeRuns),
      note:
        'hits = recomputeIfDirty() was called but the products from last time were still valid (skipped); ' +
        'misses = a real recompute ran. A miss rate far above the real content-change rate during passive ' +
        'panning (no document edits in this window) would point at the arity-1 CRUD-hook over-invalidation ' +
        'Performance-Audit-2026-08.md §5.8 already named but never measured directly.',
    });
  },
  // TIER A (cache-completeness pass, 2026-08-12) — three caches that already
  // had native stats reachable through the existing diagnostics aggregator;
  // this pass only needed to read them, not instrument anything new.
  compressedTextureWorker(start, end) {
    if (!end || isSkipped(end)) return null;
    const bcOkStart = start ? (start.bc1 ?? 0) + (start.bc7 ?? 0) + (start.alphaOk ?? 0) : null;
    const bcOkEnd = (end.bc1 ?? 0) + (end.bc7 ?? 0) + (end.alphaOk ?? 0);
    const hits = delta(start?.cached, end.cached);
    const okDelta = delta(bcOkStart, bcOkEnd);
    return row({
      id: 'compressedTextureWorker',
      label: 'Compressed-texture worker (BC1/BC7 + coarse-alpha jobs)',
      hits,
      misses: hits !== null && okDelta !== null ? Math.max(0, okDelta - hits) : null,
      note:
        "hits = jobs served from the worker's own persisted cache (cached — ONE counter shared by both BC-" +
        'texture and coarse-alpha-grid job types, compressed-textures.js does not split it per mode); misses = ' +
        'successful jobs that were freshly computed instead of served from cache. Failed/unavailable jobs are ' +
        'in neither bucket — see wholeImage.compressed.worker.failed/alphaFailed/unavailable in the raw ' +
        'instrument (instrument.cacheStats) for those.',
    });
  },
  coarseAlphaGridRequests(start, end) {
    if (!end || isSkipped(end)) return null;
    return row({
      id: 'coarseAlphaGridRequests',
      label: 'Coarse alpha-grid requests (per-item memoization)',
      hits: delta(start?.delivered, end.delivered),
      misses: delta(start?.failed, end.failed),
      note:
        "The CALLER-side layer (vt-pan-viewer.js's alphaRequested Set, keyed per item id — never re-asks for " +
        'the same item once requested) — a DIFFERENT layer from compressedTextureWorker above, which is the ' +
        'WORKER-side job cache those requests feed into. hits = delivered (grid received); misses = failed ' +
        '(request errored or the worker had no coverage data for that source). requested/skippedTokens are ' +
        'point-in-time counts, not part of this hit/miss pair.',
    });
  },
  waterBodyBakeGate(start, end) {
    if (!end || isSkipped(end) || end.available === false) return null;
    const validStart = start && start.available !== false ? start : null;
    const bakeDelta = delta(validStart?.bakes, end.bakes);
    const pollDelta = delta(validStart?.polls, end.polls);
    return row({
      id: 'waterBodyBakeGate',
      label: 'Water body jump-flood bake gate (mask/floor version poll)',
      ownerEffectId: 'water',
      hits: pollDelta !== null && bakeDelta !== null ? Math.max(0, pollDelta - bakeDelta) : null,
      misses: bakeDelta,
      note:
        'hits = polls that found the mask version and resolved floor unchanged (skipped the flood); misses = ' +
        'bakes — a real jump-flood recompute ran. Same bake-vs-poll doctrine as maskAuthorityBakeGate above: if ' +
        'misses tracks the poll count 1:1 this window, the version check is broken and every poll is paying ' +
        "for a full flood — water-body-subsystem.js's own §1 exit criterion.",
    });
  },
  // BAKE-GATE SITES (cache-completeness pass, 2026-08-12) — bakeRuns/
  // bakeSkips counter pairs, mirroring mask-authority.js's own pattern
  // exactly, added at the producer this pass. sunShadowBakeGate itself is
  // handled by buildSunShadowBakeGateRows below (ONE raw snapshot, TWO
  // rows — the same "raw key ≠ adapter key" shape as pointLightWallClip,
  // so it cannot live in this per-key-matched map).
  fireMaskBakeGate(start, end) {
    if (!end || isSkipped(end)) return null;
    return row({
      id: 'fireMaskBakeGate',
      label: 'Fire mask extraction bake gate (painted fire region → fire sources)',
      ownerEffectId: 'fire',
      hits: delta(start?.bakeSkips, end.bakeSkips),
      misses: delta(start?.bakeRuns, end.bakeRuns),
      note:
        'hits = the floorIndex+signature+version triple matched the cached slot (skipped the chamfer distance ' +
        "transform); misses = a real re-extraction ran. Single-slot cache (boot.js's fireMaskCache) — switching " +
        'floors every frame would show as a 100% miss rate here, which is correct behaviour, not a broken cache.',
    });
  },
  fireSpawnBakeGate(start, end) {
    if (!end || isSkipped(end)) return null;
    return row({
      id: 'fireSpawnBakeGate',
      label: 'Fire spawn-cloud extraction bake gate (painted fire region → particle spawn points)',
      ownerEffectId: 'fire',
      hits: delta(start?.bakeSkips, end.bakeSkips),
      misses: delta(start?.bakeRuns, end.bakeRuns),
      note:
        'Same gate shape as fireMaskBakeGate above, on a SEPARATE single-slot cache (fireSpawnCache) — a miss ' +
        'here re-seeds every fire particle engine, which is far more expensive than a mask-extraction miss.',
    });
  },
  windFieldBakeGate(start, end) {
    if (!end || isSkipped(end)) return null;
    return row({
      id: 'windFieldBakeGate',
      label: 'Wind field bake (5 trigger reasons, no single upstream skip gate)',
      misses: delta(start?.total, end.total),
      note:
        'MISSES-ONLY, deliberately: every call to bakeWindField() is a real, uncached rebake by definition — 4 ' +
        'of its 5 trigger reasons (startup/floor-change/ambient-change/manual) have no poll/skip step at all, ' +
        "and the 5th (mask-change) already skips upstream in pollMaskAuthorityForWindRebake's own throttle+" +
        'version-compare, before ever reaching this function — a skip counter added HERE could only ever read ' +
        '0. A high count during passive panning (no walls/doors/floor changes) points at one of those triggers ' +
        'firing more than it should. Per-reason breakdown is in instrument.cacheStats.windFieldBakeGate.byReason.',
    });
  },
  islandPackBakeGate(start, end) {
    if (!end || isSkipped(end) || end.available === false) return null;
    const validStart = start && start.available !== false ? start : null;
    return row({
      id: 'islandPackBakeGate',
      label: 'Specular island-pack bake (mask load OR islandSpread change)',
      ownerEffectId: 'specular',
      misses: delta(validStart?.islandPackBakeCount, end.islandPackBakeCount),
      note:
        'MISSES-only, same doctrine as windFieldBakeGate above: bakeIslandPack has no internal skip branch, ' +
        'and its two triggers (a mask-load continuation vs. a live islandSpread drag) have incomparable ' +
        'upstream gating, so no honest hits counter exists. A high count during passive panning (no mask ' +
        'reload, no islandSpread drag in progress) would be unexpected — this bake is a connected-component ' +
        'label pass over up to 512×512 texels, not cheap.',
    });
  },
  pyramidStore(start, end) {
    if (!end || isSkipped(end)) return null;
    return row({
      id: 'pyramidStore',
      label: 'IndexedDB page-blob persistence (vt/pyramid-store.js)',
      hits: delta(start?.hits, end.hits),
      misses: delta(start?.misses, end.misses),
      note:
        'hits = getPageBlob found a persisted page (a tiny ~256² blob) and the caller avoided re-decoding the ' +
        'full source image; misses = not found, the caller falls back to slicing from source. A near-0% hit ' +
        'rate on a scene revisit (not first-ever load) would mean persistence is not actually surviving between ' +
        "sessions. writes/writeFailures (in the raw instrument, not this row) are putPageBlob's own outcome.",
    });
  },
  // UI/EDITOR CACHES (cache-completeness pass, 2026-08-12) — lower priority
  // than the render-path pools above (GM-only tooling), but every single
  // cache means these too. paintModeGridCache is handled separately below
  // (ONE raw object, two rows — the pointLightWallClip shape) since its
  // fields are prefixed (canvasHits/imageDataHits) rather than nested.
  describeRenderMode(start, end) {
    if (!end || isSkipped(end)) return null;
    return row({
      id: 'describeRenderMode',
      label: 'Render-mode diagnostic cache (diag/render-fallback.js)',
      hits: delta(start?.hits, end.hits),
      misses: delta(start?.misses, end.misses),
      note:
        'hits = the cached answer (up to 250ms old) reused; misses = a real recompute ran, forcing the DOM ' +
        'style-recalc getComputedStyle/getBoundingClientRect reads this cache exists to throttle. Called from ' +
        'the diagnostics builder on every report, so misses roughly track report-build frequency, not frames.',
    });
  },
  anchorMarkerPool(start, end) {
    if (!end || isSkipped(end)) return null;
    return row({
      id: 'anchorMarkerPool',
      label: 'Anchor-mode marker icon pool (place/edit tool)',
      hits: delta(start?.hits, end.hits),
      misses: delta(start?.misses, end.misses),
      note:
        'hits = an existing marker icon reused (its anchor refreshed in place); misses = a new anchor id, its ' +
        'icon element created. Runs every animation frame while the GM has the anchor placement tool open — ' +
        'zero activity is normal and expected outside that session.',
    });
  },
  anchorViewMarkerPool(start, end) {
    if (!end || isSkipped(end)) return null;
    return row({
      id: 'anchorViewMarkerPool',
      label: 'Anchor-view-mode marker icon pool (see-all/toggle tool)',
      hits: delta(start?.hits, end.hits),
      misses: delta(start?.misses, end.misses),
      note:
        'The read/toggle sibling of anchorMarkerPool above (ui/anchor-view-mode.js) — a SEPARATE Map/session, ' +
        'active only while the GM has the "see every anchor" scene-controls button open.',
    });
  },
  // SPECIAL CASES (cache-completeness pass, 2026-08-12 §5F-3) — see this
  // file's own header for the full reasoning on why these two do not fit
  // the standard start/end-delta shape, and why graph/frame-graph.js's pool
  // has no adapter here at all.
  maskDiscovery(start, end) {
    // Not delta'd — `start` is ignored on purpose. This is a ONE-SHOT
    // scene-load summary (see this file's own header): start and end would
    // almost always be byte-identical anyway, since discovery finishes long
    // before any perf-run-full window opens.
    if (!end) return null;
    return row({
      id: 'maskDiscovery',
      label: 'Mask discovery (scene-load, one-shot — not a per-window rate)',
      size: Number.isFinite(end.floorsWithMasks) ? end.floorsWithMasks : null,
      capacity: Number.isFinite(end.floorsDiscovered) ? end.floorsDiscovered : null,
      note:
        "ONE-SHOT: foundry/mask-discovery.js's own directory-listing/probe caches (listingCache/probeMemo) " +
        'are function-LOCAL to discoverAuthoredMasks, discarded the instant it returns — there is no ongoing ' +
        'hit/miss pair to poll, so hits/misses stay null on purpose. size/capacity are floorsWithMasks/' +
        'floorsDiscovered from the ONE run at scene load; probesAttempted/method/failures are in ' +
        'instrument.cacheStats.maskDiscovery — real network cost paid once, not per frame.',
    });
  },
  pixiProxy(start, end) {
    if (!end) return null;
    return row({
      id: 'pixiProxy',
      label: 'PIXI texture-proxy write attempts (foundry/pixi-proxy-textures.js)',
      hits: delta(start?.alreadyCached, end.alreadyCached),
      misses: delta(start?.registered, end.registered),
      note:
        "NOT a hit/miss rate against Foundry's own PIXI.Assets.cache — this module cannot see lookups made " +
        "against that store (this file's own header). hits = registerPixiProxy was asked to seed a src " +
        'already resident (a redundant call correctly skipped); misses = a genuinely new proxy was seeded ' +
        '(real work — an OffscreenCanvas draw + createImageBitmap). skippedTooSmall/unavailable (in the raw ' +
        'instrument, not this row) are structural non-applicability, neither outcome.',
    });
  },
};

/** label/ownerEffectId for each of `pointLightWallClip`'s four sub-caches —
 * one raw object, four rows, so this is handled outside the single-row
 * adapter map above. */
const POINT_LIGHT_WALL_CLIP_SUB = {
  candle: { label: 'Point light: candle wall-clip cache', ownerEffectId: 'candleFlame' },
  lightning: { label: 'Point light: lightning wall-clip cache', ownerEffectId: 'lightning' },
  regular: {
    label: 'Point light: real-light wall-clip cache',
    note: 'The 9.9%-of-a-frame cost light.pointLightWallClip now zones directly — see that zone for the CPU cost this cache exists to avoid.',
  },
  apertureWalls: { label: 'Point light: aperture-gobo wall segments', ownerEffectId: 'apertureGobo' },
};

function buildPointLightWallClipRows(start, end) {
  if (!end || isSkipped(end)) return [];
  const rows = [];
  for (const [key, meta] of Object.entries(POINT_LIGHT_WALL_CLIP_SUB)) {
    const e = end[key];
    if (!e) continue;
    const s = start?.[key] ?? null;
    rows.push(
      row({
        id: `pointLightWallClip.${key}`,
        label: meta.label,
        ownerEffectId: meta.ownerEffectId ?? null,
        hits: delta(s?.hits, e.hits),
        misses: delta(s?.misses, e.misses),
        evictions: 'evictions' in e ? delta(s?.evictions, e.evictions) : null,
        note: meta.note ?? null,
      })
    );
  }
  return rows;
}

/** `sunShadowBakeGate`'s raw shape is ONE `{floors: [...]}` snapshot carrying
 * TWO independent gates per floor (`bakeGate.casterFieldBake*` and
 * `bakeGate.sunShadowBake*` — see sun-shadow-subsystem.js's own header on
 * why they can diverge) — one raw object, two rows, so this is handled
 * outside the single-row adapter map above, the same reason
 * buildPointLightWallClipRows is. */
function buildSunShadowBakeGateRows(start, end) {
  if (!end || isSkipped(end) || !Array.isArray(end.floors)) return [];
  return [
    row({
      id: 'sunShadowCasterFieldBakeGate',
      label: 'Sun-shadow caster field bake gate (per-floor, summed)',
      ownerEffectId: 'sunShadows',
      hits: delta(
        sumFloorBakeGateField(start, 'casterFieldBakeSkips'),
        sumFloorBakeGateField(end, 'casterFieldBakeSkips')
      ),
      misses: delta(
        sumFloorBakeGateField(start, 'casterFieldBakeRuns'),
        sumFloorBakeGateField(end, 'casterFieldBakeRuns')
      ),
      note:
        "Summed across every floor slot with an active caster field (sun-shadow-subsystem.js's createFloorSlot, " +
        'one slot per floor). hits = the version check found the caster field already current (skip); misses = ' +
        'a real chamfer/coverage bake ran. A DIFFERENT gate from sunShadowFieldBakeGate below — see that row. ' +
        'Per-floor breakdown is in instrument.cacheStats.sunShadowBakeGate.floors[].bakeGate.',
    }),
    row({
      id: 'sunShadowFieldBakeGate',
      label: 'Sun-shadow field bake gate (params/geometry/cascade/sun-angle, per-floor summed)',
      ownerEffectId: 'sunShadows',
      hits: delta(sumFloorBakeGateField(start, 'sunShadowBakeSkips'), sumFloorBakeGateField(end, 'sunShadowBakeSkips')),
      misses: delta(sumFloorBakeGateField(start, 'sunShadowBakeRuns'), sumFloorBakeGateField(end, 'sunShadowBakeRuns')),
      note:
        'A DIFFERENT gate from sunShadowCasterFieldBakeGate above — this one covers the actual shadow-field ' +
        'bake (params/geometry/cascade/sun-angle changed), which can miss even when the caster field above ' +
        'reads clean. Summed across every floor slot; per-floor breakdown is in ' +
        'instrument.cacheStats.sunShadowBakeGate.floors[].bakeGate.',
    }),
  ];
}

/** `paintModeGridCache`'s raw shape is ONE `{canvasHits, canvasMisses,
 * imageDataHits, imageDataMisses}` object (ui/paint-mode.js's own
 * gridCachePoolStats) — prefixed fields rather than nested sub-objects, so
 * this needs its own small fan-out rather than either the generic adapter
 * map or buildSimplePoolRows. Two rows: the offscreen canvas element can hit
 * even on a frame the ImageData buffer misses (a resize keeps the same
 * canvas but needs a fresh, correctly-sized ImageData). */
function buildPaintModeGridCacheRows(start, end) {
  if (!end || isSkipped(end)) return [];
  return [
    row({
      id: 'paintModeGridCanvas',
      label: 'Paint-mode offscreen canvas pool (per mask key)',
      ownerEffectId: null,
      hits: delta(start?.canvasHits, end.canvasHits),
      misses: delta(start?.canvasMisses, end.canvasMisses),
      note: 'hits = an existing offscreen canvas element reused for this kind::floor key; misses = created for the first time.',
    }),
    row({
      id: 'paintModeGridImageData',
      label: 'Paint-mode grid ImageData pool (per mask key)',
      ownerEffectId: null,
      hits: delta(start?.imageDataHits, end.imageDataHits),
      misses: delta(start?.imageDataMisses, end.imageDataMisses),
      note:
        'hits = the packed ImageData buffer reused at its current size; misses = (re)allocated — either the ' +
        'first paint of this key, or the canvas dimensions changed under it. A DIFFERENT counter from ' +
        'paintModeGridCanvas above: a canvas hit can still pair with an ImageData miss on a resize.',
    }),
  ];
}

/**
 * Fan a `{subKey: {hits, misses, size}, ...}` snapshot into one row per
 * subKey — the general form of buildPointLightWallClipRows above, for pools
 * whose raw shape already IS exactly `{hits, misses, size}` per sub-cache
 * (point-light-pool.js's getMeshPoolStats, this file's own getVtPoolStats,
 * door-graphics-subsystem.js's getPoolStats — all three built to the SAME
 * shape specifically so one fan-out function could serve them all).
 * @param {object|null} start @param {object|null} end
 * @param {Record<string, {label: string, ownerEffectId?: string, note?: string}>} meta
 */
function buildSimplePoolRows(start, end, meta) {
  if (!end || isSkipped(end)) return [];
  const rows = [];
  for (const [key, m] of Object.entries(meta)) {
    const e = end[key];
    if (!e) continue;
    const s = start?.[key] ?? null;
    rows.push(
      row({
        id: key,
        label: m.label,
        ownerEffectId: m.ownerEffectId ?? null,
        hits: delta(s?.hits, e.hits),
        misses: delta(s?.misses, e.misses),
        size: Number.isFinite(e.size) ? e.size : null,
        note: m.note ?? null,
      })
    );
  }
  return rows;
}

const POINT_LIGHT_MESH_POOL_META = {
  lightMeshes: {
    label: 'Point light per-light mesh pool (unbatched lights)',
    note:
      'hits = an existing entry survived its own staleness check (animationQuality/falloffModel/apertureCount/' +
      'apGoboCols/apGoboRows all unchanged) — reused with no mesh/material/geometry rebuild. misses = a brand-' +
      'new light OR an existing one that failed that check and was torn down + recreated. A light that BATCHES ' +
      'this frame never reaches this pool at all — see illumBuckets/colorBuckets below.',
  },
  illumBuckets: {
    label: 'Point light illumination batch buckets (Stage 2 batching)',
    note:
      'PER-BUCKET-KEY, not per-light — hits = an existing bucket mesh reused for this key; misses = a brand-new ' +
      'bucket key, its mesh built once. Near-zero activity (both hits and misses) when pointLightBatchingEnabled ' +
      'is off, since no light is ever admitted to a bucket.',
  },
  colorBuckets: {
    label: 'Point light coloration batch buckets (Stage 2 batching)',
    note:
      'The coloration sibling of illumBuckets above — a SEPARATE registry (own meshes, own materials): a bucket ' +
      'key can exist in one without the other (isColorationEligible gates coloration membership independently).',
  },
};

const VT_MESH_POOL_META = {
  regionMeshes: {
    label: 'Region-darkness mesh pool',
    note:
      "hits = an existing region shape's mesh reused untouched; misses = a brand-new regionId:shapeIndex key OR " +
      'an existing one whose shape TYPE changed under the same key (shapes are not retyped in place by Foundry — ' +
      'handled defensively anyway, same posture as lightMeshes).',
  },
  occlusionDiscs: {
    label: 'Token occlusion disc pool',
    note: 'hits = an existing token disc reused (materials are never rebuilt); misses = a token seen for the first time this session.',
  },
  itemStates: {
    label: 'VT item load-state pool (per-item asset load)',
    note:
      'hits = an already-loaded item reused with no re-decode/re-fetch; misses = the full async ' +
      "getSourceDimensions+loadExtraLayerPacks chain ran — by far the most expensive of this pool's two " +
      'outcomes, and the one worth watching for an unexpectedly climbing count during passive panning.',
  },
};

const DOOR_POOL_META = {
  doorTextureCache: {
    label: 'Door texture cache',
    note:
      'hits = a real cached {texture,...} object reused; misses = a URL never seen before, a fresh ' +
      "TextureLoader().load() kicked off. A 'pending'/'failed' read is neither — see door-graphics-subsystem.js's own doc.",
  },
  doorLeaves: {
    label: 'Door leaf geometry pool',
    note: 'hits = existing leaves reused untouched; misses = the leaf COUNT (single↔double) or texture changed, buildDoorLeaves reran.',
  },
};

/**
 * The cache-shaped instruments that already have their own dedicated report
 * fields and findings — mirrored here as ONE summary row each, not
 * re-derived. `pipelineStats`/`depthProxyPoolStats` are `{start, end}` pairs
 * (same shape `perf-session.js` already builds); `shaderRebuildStats`/
 * `pipelineRebuildStats`/`passSlotStats` are each already a single delta-
 * since-arm read (the probe resets itself to zero on every arm — see
 * `perf-report.js`'s own comment on why those need no start/end pairing);
 * `windowDiagnostics` is a point-in-time array, not a counter at all.
 */
function buildMirroredRows({
  depthProxyPoolStats,
  shaderRebuildStats,
  pipelineRebuildStats,
  passSlotStats,
  windowDiagnostics,
}) {
  const rows = [];
  const dpp = depthProxyPoolStats;
  if (dpp?.start && dpp?.end) {
    const hits = delta(dpp.start.hits, dpp.end.hits);
    const misses = delta(dpp.start.misses, dpp.end.misses);
    rows.push(
      row({
        id: 'depthProxyMaterialPool',
        label: 'Depth-proxy material pool (tile early-Z materials)',
        hits,
        misses,
        evictions: delta(dpp.start.evictions, dpp.end.evictions),
        size: Number.isFinite(dpp.end.size) ? dpp.end.size : null,
        note: 'Mirrors instrument.depthProxyPoolStats — see findings[] for depth-proxy-pool-health, the tuned verdict on this same data.',
      })
    );
  }
  if (shaderRebuildStats?.installed === true) {
    rows.push(
      row({
        id: 'shaderNodeBuilderCache',
        label: "three's shader node-graph cache (nodeBuilderCache)",
        hits: Number.isFinite(shaderRebuildStats.hits) ? shaderRebuildStats.hits : null,
        misses: Number.isFinite(shaderRebuildStats.misses) ? shaderRebuildStats.misses : null,
        note: 'Mirrors instrument.shaderRebuildStats — see findings[] for shader-rebuild-churn (per-label detail) and depth-proxy-material-pool.js (the mechanism this probe watches for).',
      })
    );
  }
  if (pipelineRebuildStats?.installed === true) {
    rows.push(
      row({
        id: 'shaderPipelineCache',
        label: "three's GPU pipeline cache (device.createRenderPipeline)",
        hits: Number.isFinite(pipelineRebuildStats.hits) ? pipelineRebuildStats.hits : null,
        misses: Number.isFinite(pipelineRebuildStats.misses) ? pipelineRebuildStats.misses : null,
        note: 'Mirrors instrument.pipelineRebuildStats — a DIFFERENT cache from shaderNodeBuilderCache above (can miss even when that one reads clean); see findings[] for pipeline-rebuild-churn.',
      })
    );
  }
  if (passSlotStats && Number.isFinite(passSlotStats.slots)) {
    const capacity =
      Number.isFinite(passSlotStats.slots) && Number.isFinite(passSlotStats.declaredCount)
        ? passSlotStats.slots - passSlotStats.declaredCount
        : null;
    rows.push(
      row({
        id: 'framePassSlotAllocator',
        label: 'Frame profiler pass-slot allocator (dynamic GPU pass ids)',
        size: Number.isFinite(passSlotStats.passSlotsUsed) ? passSlotStats.passSlotsUsed : null,
        capacity,
        note:
          "Mirrors instrument.passSlotStats — frame-profiler.js's own passId→slot Map (get-or-create per " +
          "distinct GPU pass name), reset every arm() so this is already this window's own count. No " +
          'hits/misses counter exists on the get-or-create branch — size only says how many distinct passes ' +
          'were seen, not how often each was reused. size at capacity means passSlotOverflow ' +
          '(instrument.profilerAnomalies) is silently dropping any FURTHER new pass name for the rest of this ' +
          'window — check that field alongside this row.',
      })
    );
  }
  if (Array.isArray(windowDiagnostics)) {
    rows.push(
      row({
        id: 'windowSurfacesByFloor',
        label: 'Window-surface subsystem cache (one per floor, lazily created)',
        ownerEffectId: 'window',
        size: windowDiagnostics.length,
        note:
          "Mirrors instrument.windowDiagnostics — vt-pan-viewer.js's windowSurfacesByFloor Map: one subsystem " +
          'created and cached per floor index the first time that floor syncs, reused for the rest of the ' +
          "session, disposed only when the floor leaves the scene's floor list. No hits/misses counter exists " +
          'on the create-vs-reuse branch — size is how many floors currently hold a live cached entry; see ' +
          'findings[] for window-surface-composition, the tuned verdict on this same per-floor detail.',
      })
    );
    rows.push(
      row({
        id: 'windowMaskReloadGate',
        label: 'Window mask reload gate (per-floor, summed — LIFETIME, not windowed)',
        ownerEffectId: 'window',
        hits: windowDiagnostics.reduce(
          (acc, f) => acc + (Number.isFinite(f?.maskReloadGate?.hits) ? f.maskReloadGate.hits : 0),
          0
        ),
        misses: windowDiagnostics.reduce(
          (acc, f) => acc + (Number.isFinite(f?.maskReloadGate?.misses) ? f.maskReloadGate.misses : 0),
          0
        ),
        note:
          'LIFETIME totals since each floor first synced, summed across every floor — NOT a delta over this ' +
          'measured window (windowDiagnostics is a point-in-time snapshot with no start pairing to delta ' +
          'against, unlike cacheStats above). hits = the same url+floor was already loaded (skipped the ' +
          'reload); misses = a genuinely new mask load kicked off — expect misses in the single digits per ' +
          'floor for the whole session; a climbing count during passive panning means something is ' +
          're-triggering ensureMaskImage with a changed url/floor unexpectedly.',
      })
    );
  }
  return rows;
}

/**
 * Build the report's `caches[]` array from everything a run collected.
 *
 * @param {object} args
 * @param {{start: object, end: object}|null} [args.cacheStats] - the keyed
 *   snapshot pair from `harness.readCacheStats()` (boot.js's `profileHarness`).
 * @param {{start: object, end: object}|null} [args.depthProxyPoolStats]
 * @param {object|null} [args.shaderRebuildStats]
 * @param {object|null} [args.pipelineRebuildStats]
 * @param {object|null} [args.passSlotStats]
 * @param {object[]|null} [args.windowDiagnostics]
 * @returns {object[]}
 */
export function buildCacheRows({
  cacheStats = null,
  depthProxyPoolStats = null,
  shaderRebuildStats = null,
  pipelineRebuildStats = null,
  passSlotStats = null,
  windowDiagnostics = null,
} = {}) {
  const start = cacheStats?.start ?? null;
  const end = cacheStats?.end ?? null;
  const rows = [];
  for (const [id, adapter] of Object.entries(RAW_CACHE_ADAPTERS)) {
    const r = adapter(start?.[id] ?? null, end?.[id] ?? null);
    if (r) rows.push(r);
  }
  rows.push(...buildPointLightWallClipRows(start?.pointLightWallClip ?? null, end?.pointLightWallClip ?? null));
  rows.push(...buildSunShadowBakeGateRows(start?.sunShadowBakeGate ?? null, end?.sunShadowBakeGate ?? null));
  rows.push(
    ...buildSimplePoolRows(
      start?.pointLightMeshPools ?? null,
      end?.pointLightMeshPools ?? null,
      POINT_LIGHT_MESH_POOL_META
    )
  );
  rows.push(...buildSimplePoolRows(start?.vtMeshPools ?? null, end?.vtMeshPools ?? null, VT_MESH_POOL_META));
  rows.push(...buildSimplePoolRows(start?.doorPools ?? null, end?.doorPools ?? null, DOOR_POOL_META));
  rows.push(...buildPaintModeGridCacheRows(start?.paintModeGridCache ?? null, end?.paintModeGridCache ?? null));
  rows.push(
    ...buildMirroredRows({
      depthProxyPoolStats,
      shaderRebuildStats,
      pipelineRebuildStats,
      passSlotStats,
      windowDiagnostics,
    })
  );
  return rows;
}

/**
 * A cache whose hit rate looks unhealthy during a window that should mostly
 * be steady-state reuse — the generalised form of `depth-proxy-pool-health`'s
 * own hand-tuned check, applied to every row this file produces. Deliberately
 * cheap and blunt (one fixed threshold, no per-cache tuning): the point is to
 * stop a low hit rate going unremarked the way `apertureSegCache` and the
 * three wall-clip Maps did for their whole lifetime before this file existed,
 * not to replace a human deciding whether THIS particular number is bad for
 * THIS particular cache's own workload.
 * @param {object[]} rows
 * @returns {{id: string, label: string, hitRatePct: number, hits: number, misses: number}[]}
 */
export function findLowHitRateCaches(rows, { minRatePct = 50, minSamples = 5 } = {}) {
  return rows.filter((r) => {
    if (r.hitRatePct === null) return false;
    const total = (r.hits ?? 0) + (r.misses ?? 0);
    return total >= minSamples && r.hitRatePct < minRatePct;
  });
}
