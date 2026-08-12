/**
 * Node tests for cache-report.js — the cache-row adapter.
 *
 * Pinned hardest: NEVER fabricate a hits/misses/hitRatePct number a cache's
 * own raw stats do not support (page-cache has no hits counter at all — a
 * fabricated one there would be exactly the class of lie
 * feedback_instruments_must_not_lie names), and a `{skipped:true}` read
 * (viewer not started) must produce no row rather than a row full of nulls
 * masquerading as "measured and empty".
 */
import { buildCacheRows, findLowHitRateCaches } from '../cache-report.js';

export function run(t) {
  const { ok } = t;

  // ======================================================================
  // buildCacheRows — absence handling
  // ======================================================================
  {
    ok('buildCacheRows with no args returns an empty array, not a throw', Array.isArray(buildCacheRows()));
    ok('buildCacheRows() is empty', buildCacheRows().length === 0);
    ok(
      'buildCacheRows with cacheStats:null (harness has no readCacheStats) returns empty',
      buildCacheRows({ cacheStats: null }).length === 0
    );
    ok(
      'buildCacheRows with only a start snapshot (no end) skips every raw-cache row — half a window is not a window',
      buildCacheRows({ cacheStats: { start: { vtPageCache: { misses: 1, evictions: 0 } }, end: null } }).length === 0
    );
    ok(
      'a {skipped:true} end snapshot (viewer not started) produces no row for that cache',
      buildCacheRows({
        cacheStats: {
          start: { vegetationProxyNodeCache: { hits: 0, misses: 0 } },
          end: { vegetationProxyNodeCache: { skipped: true, reason: 'viewer not started' } },
        },
      }).length === 0
    );
  }

  // ======================================================================
  // vtPageCache — no hits counter exists; must never be fabricated
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { vtPageCache: { misses: 10, evictions: 2, residentPages: 900, capacityPages: 1200 } },
        end: { vtPageCache: { misses: 34, evictions: 5, residentPages: 950, capacityPages: 1200 } },
      },
    });
    const r = rows.find((x) => x.id === 'vtPageCache');
    ok('vtPageCache produces a row', !!r);
    ok('vtPageCache.hits is null — this cache has no hits counter to report', r.hits === null);
    ok('vtPageCache.misses is the window DELTA (34-10=24), not the lifetime total', r.misses === 24);
    ok('vtPageCache.evictions is the window delta (5-2=3)', r.evictions === 3);
    ok('vtPageCache.size is the END snapshot occupancy (950), not a delta', r.size === 950);
    ok('vtPageCache.capacity is the END snapshot capacity', r.capacity === 1200);
    ok('vtPageCache.hitRatePct is null because hits is null — a rate needs both sides', r.hitRatePct === null);
    ok(
      'vtPageCache carries a note explaining the missing hits counter',
      typeof r.note === 'string' && r.note.length > 0
    );
  }

  // ======================================================================
  // vtDecodePool — the idbHits/sourcesDecoded pairing
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { vtDecodePool: { idbHits: 5, sourcesDecoded: 1 } },
        end: { vtDecodePool: { idbHits: 45, sourcesDecoded: 6 } },
      },
    });
    const r = rows.find((x) => x.id === 'vtDecodePool');
    ok('vtDecodePool.hits is the idbHits delta (45-5=40)', r.hits === 40);
    ok('vtDecodePool.misses is the sourcesDecoded delta (6-1=5)', r.misses === 5);
    ok('vtDecodePool.hitRatePct is computed from the two deltas (40/45)', r.hitRatePct === 88.9);
  }

  // ======================================================================
  // vegetationProxyNodeCache
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { vegetationProxyNodeCache: { hits: 0, misses: 0 } },
        end: { vegetationProxyNodeCache: { hits: 118, misses: 3 } },
      },
    });
    const r = rows.find((x) => x.id === 'vegetationProxyNodeCache');
    ok('vegetationProxyNodeCache is owned by vegetation', r.ownerEffectId === 'vegetation');
    ok('vegetationProxyNodeCache.hits delta', r.hits === 118);
    ok('vegetationProxyNodeCache.misses delta', r.misses === 3);
    ok('vegetationProxyNodeCache.size is null — a WeakMap reports no occupancy', r.size === null);
  }

  // ======================================================================
  // maskAuthorityBakeGate — hits/misses are deliberately the INVERSE of the
  // raw field names (bakeSkips = hit, bakeRuns = miss)
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { maskAuthorityBakeGate: { bakeRuns: 2, bakeSkips: 40 } },
        end: { maskAuthorityBakeGate: { bakeRuns: 3, bakeSkips: 600 } },
      },
    });
    const r = rows.find((x) => x.id === 'maskAuthorityBakeGate');
    ok('maskAuthorityBakeGate.hits = bakeSkips delta (600-40=560)', r.hits === 560);
    ok('maskAuthorityBakeGate.misses = bakeRuns delta (3-2=1)', r.misses === 1);
    ok('a healthy bake gate reads a very high hit rate', r.hitRatePct > 99);
  }

  // ======================================================================
  // compressedTextureWorker — `cached` is ONE counter shared by BOTH
  // BC-texture and coarse-alpha-grid job types (compressed-textures.js does
  // not split it per mode) — misses is derived, not a raw field
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { compressedTextureWorker: { bc1: 10, bc7: 2, alphaOk: 5, cached: 8, failed: 1, alphaFailed: 0 } },
        end: { compressedTextureWorker: { bc1: 40, bc7: 10, alphaOk: 20, cached: 55, failed: 2, alphaFailed: 1 } },
      },
    });
    const r = rows.find((x) => x.id === 'compressedTextureWorker');
    ok('compressedTextureWorker produces a row', !!r);
    ok('compressedTextureWorker.hits is the cached delta (55-8=47)', r.hits === 47);
    ok('compressedTextureWorker.misses is successful completions minus hits ((70-17)-47=6)', r.misses === 6);
    ok('compressedTextureWorker carries a note explaining the shared cached counter', r.note.includes('ONE counter'));
  }

  // ======================================================================
  // compressedTextureWorker — an async sampling-boundary skew must never
  // print a negative misses count
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { compressedTextureWorker: { bc1: 10, bc7: 0, alphaOk: 0, cached: 10 } },
        end: { compressedTextureWorker: { bc1: 12, bc7: 0, alphaOk: 0, cached: 13 } },
      },
    });
    const r = rows.find((x) => x.id === 'compressedTextureWorker');
    ok('compressedTextureWorker.misses is clamped to 0, never a fabricated negative', r.misses === 0);
  }

  // ======================================================================
  // coarseAlphaGridRequests — the CALLER-side per-item memoization layer,
  // distinct from compressedTextureWorker's WORKER-side job cache above
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { coarseAlphaGridRequests: { requested: 5, delivered: 4, failed: 1, skippedTokens: 0 } },
        end: { coarseAlphaGridRequests: { requested: 205, delivered: 190, failed: 6, skippedTokens: 12 } },
      },
    });
    const r = rows.find((x) => x.id === 'coarseAlphaGridRequests');
    ok('coarseAlphaGridRequests.hits is the delivered delta (190-4=186)', r.hits === 186);
    ok('coarseAlphaGridRequests.misses is the failed delta (6-1=5)', r.misses === 5);
  }

  // ======================================================================
  // waterBodyBakeGate — bakes vs polls, the same gate doctrine as
  // maskAuthorityBakeGate above
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { waterBodyBakeGate: { bakes: 1, polls: 40 } },
        end: { waterBodyBakeGate: { bakes: 2, polls: 3000 } },
      },
    });
    const r = rows.find((x) => x.id === 'waterBodyBakeGate');
    ok('waterBodyBakeGate is owned by water', r.ownerEffectId === 'water');
    ok('waterBodyBakeGate.misses is the bakes delta (2-1=1)', r.misses === 1);
    ok('waterBodyBakeGate.hits is polls-delta minus bakes-delta ((3000-40)-1=2959)', r.hits === 2959);
    ok('a healthy water bake gate reads a very high hit rate', r.hitRatePct > 99);
  }

  // ======================================================================
  // waterBodyBakeGate — {available:false} (defensive shape for no live
  // viewer) produces no row, never a row full of nulls
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { waterBodyBakeGate: { available: false } },
        end: { waterBodyBakeGate: { available: false } },
      },
    });
    ok(
      'waterBodyBakeGate:{available:false} produces no row',
      rows.every((r) => r.id !== 'waterBodyBakeGate')
    );
  }

  // ======================================================================
  // sunShadowCasterFieldBakeGate / sunShadowFieldBakeGate — TWO gates
  // summed across a per-floor `{floors: [...]}` array
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: {
          sunShadowBakeGate: {
            floors: [
              {
                floorIndex: 0,
                bakeGate: {
                  casterFieldBakeRuns: 1,
                  casterFieldBakeSkips: 20,
                  sunShadowBakeRuns: 3,
                  sunShadowBakeSkips: 50,
                },
              },
              {
                floorIndex: 1,
                bakeGate: {
                  casterFieldBakeRuns: 1,
                  casterFieldBakeSkips: 10,
                  sunShadowBakeRuns: 2,
                  sunShadowBakeSkips: 30,
                },
              },
            ],
          },
        },
        end: {
          sunShadowBakeGate: {
            floors: [
              {
                floorIndex: 0,
                bakeGate: {
                  casterFieldBakeRuns: 2,
                  casterFieldBakeSkips: 220,
                  sunShadowBakeRuns: 5,
                  sunShadowBakeSkips: 550,
                },
              },
              {
                floorIndex: 1,
                bakeGate: {
                  casterFieldBakeRuns: 1,
                  casterFieldBakeSkips: 110,
                  sunShadowBakeRuns: 2,
                  sunShadowBakeSkips: 330,
                },
              },
            ],
          },
        },
      },
    });
    const caster = rows.find((x) => x.id === 'sunShadowCasterFieldBakeGate');
    const sun = rows.find((x) => x.id === 'sunShadowFieldBakeGate');
    ok('sunShadowCasterFieldBakeGate produces a row', !!caster);
    ok('sunShadowFieldBakeGate produces a row', !!sun);
    ok('both are owned by sunShadows', caster.ownerEffectId === 'sunShadows' && sun.ownerEffectId === 'sunShadows');
    // caster runs summed: start (1+1=2), end (2+1=3) -> delta 1
    ok('caster misses is the SUMMED runs delta across both floors (3-2=1)', caster.misses === 1);
    // caster skips summed: start (20+10=30), end (220+110=330) -> delta 300
    ok('caster hits is the SUMMED skips delta across both floors (330-30=300)', caster.hits === 300);
    // sun runs summed: start (3+2=5), end (5+2=7) -> delta 2
    ok('sunShadowFieldBakeGate misses is the SUMMED runs delta (7-5=2)', sun.misses === 2);
    ok(
      'the two gates are independently derived — NOT the same numbers',
      caster.misses !== sun.misses || caster.hits !== sun.hits
    );
  }

  // ======================================================================
  // sunShadowBakeGate — a snapshot with no floors array produces no row
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: { start: { sunShadowBakeGate: {} }, end: { sunShadowBakeGate: { compiled: true } } },
    });
    ok(
      'a sunShadowBakeGate snapshot with no floors[] produces neither sun-shadow row',
      rows.every((r) => !r.id.startsWith('sunShadow'))
    );
  }

  // ======================================================================
  // fireMaskBakeGate / fireSpawnBakeGate — boot.js's own single-slot caches
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { fireMaskBakeGate: { bakeRuns: 1, bakeSkips: 5 }, fireSpawnBakeGate: { bakeRuns: 1, bakeSkips: 5 } },
        end: { fireMaskBakeGate: { bakeRuns: 2, bakeSkips: 90 }, fireSpawnBakeGate: { bakeRuns: 4, bakeSkips: 40 } },
      },
    });
    const mask = rows.find((x) => x.id === 'fireMaskBakeGate');
    const spawn = rows.find((x) => x.id === 'fireSpawnBakeGate');
    ok('fireMaskBakeGate produces a row owned by fire', !!mask && mask.ownerEffectId === 'fire');
    ok('fireSpawnBakeGate produces a row owned by fire', !!spawn && spawn.ownerEffectId === 'fire');
    ok('fireMaskBakeGate.misses is the bakeRuns delta (2-1=1)', mask.misses === 1);
    ok('fireMaskBakeGate.hits is the bakeSkips delta (90-5=85)', mask.hits === 85);
    ok(
      "fireSpawnBakeGate is derived from its OWN separate counters, not fireMaskBakeGate's (misses 4-1=3)",
      spawn.misses === 3
    );
  }

  // ======================================================================
  // windFieldBakeGate — MISSES-only: bakeWindField has no internal skip
  // branch, so no fabricated hits counter must ever appear
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { windFieldBakeGate: { total: 3, byReason: { startup: 1, 'mask-change': 2 } } },
        end: { windFieldBakeGate: { total: 9, byReason: { startup: 1, 'mask-change': 5, 'floor-change': 3 } } },
      },
    });
    const r = rows.find((x) => x.id === 'windFieldBakeGate');
    ok('windFieldBakeGate produces a row', !!r);
    ok('windFieldBakeGate.misses is the total delta (9-3=6)', r.misses === 6);
    ok('windFieldBakeGate.hits is null — no honest hits counter exists for this bake', r.hits === null);
    ok('windFieldBakeGate.hitRatePct is null — a rate needs both sides', r.hitRatePct === null);
  }

  // ======================================================================
  // islandPackBakeGate — MISSES-only, same doctrine as windFieldBakeGate,
  // and the {available:false} defensive shape produces no row
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { islandPackBakeGate: { islandPackBakeCount: 2 } },
        end: { islandPackBakeGate: { islandPackBakeCount: 5 } },
      },
    });
    const r = rows.find((x) => x.id === 'islandPackBakeGate');
    ok('islandPackBakeGate produces a row owned by specular', !!r && r.ownerEffectId === 'specular');
    ok('islandPackBakeGate.misses is the islandPackBakeCount delta (5-2=3)', r.misses === 3);
    ok('islandPackBakeGate.hits is null — no honest hits counter exists for this bake', r.hits === null);
    ok(
      'islandPackBakeGate:{available:false} produces no row',
      buildCacheRows({
        cacheStats: {
          start: { islandPackBakeGate: { available: false } },
          end: { islandPackBakeGate: { available: false } },
        },
      }).every((x) => x.id !== 'islandPackBakeGate')
    );
  }

  // ======================================================================
  // pointLightWallClip — ONE raw object fans out into FOUR rows
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: {
          pointLightWallClip: {
            candle: { hits: 0, misses: 0, evictions: 0 },
            lightning: { hits: 0, misses: 0, evictions: 0 },
            regular: { hits: 0, misses: 0, evictions: 0 },
            apertureWalls: { hits: 0, misses: 0 },
          },
        },
        end: {
          pointLightWallClip: {
            candle: { hits: 300, misses: 4, evictions: 0 },
            lightning: { hits: 12, misses: 8, evictions: 1 },
            regular: { hits: 5000, misses: 60, evictions: 2 },
            apertureWalls: { hits: 590, misses: 3 },
          },
        },
      },
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    ok(
      'four distinct rows come out of the one raw object',
      [
        'pointLightWallClip.candle',
        'pointLightWallClip.lightning',
        'pointLightWallClip.regular',
        'pointLightWallClip.apertureWalls',
      ].every((id) => byId[id])
    );
    ok('candle row is owned by candleFlame', byId['pointLightWallClip.candle'].ownerEffectId === 'candleFlame');
    ok('lightning row is owned by lightning', byId['pointLightWallClip.lightning'].ownerEffectId === 'lightning');
    ok(
      'regular (real Foundry lights) row has no single owning effect',
      byId['pointLightWallClip.regular'].ownerEffectId === null
    );
    ok(
      'apertureWalls row is owned by apertureGobo',
      byId['pointLightWallClip.apertureWalls'].ownerEffectId === 'apertureGobo'
    );
    ok('regular.hits delta is correct (5000-0)', byId['pointLightWallClip.regular'].hits === 5000);
    ok('regular.evictions delta is correct (2-0)', byId['pointLightWallClip.regular'].evictions === 2);
    ok(
      'apertureWalls has no evictions field in its raw shape (a single nullable object, not a Map) — must read null, not a fabricated 0',
      byId['pointLightWallClip.apertureWalls'].evictions === null
    );
  }

  // ======================================================================
  // pointLightWallClip — a sub-cache absent from a partial raw shape is
  // skipped, not crashed on or reported as zero
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { pointLightWallClip: { candle: { hits: 0, misses: 0, evictions: 0 } } },
        end: { pointLightWallClip: { candle: { hits: 10, misses: 1, evictions: 0 } } },
      },
    });
    ok('only the sub-cache actually present in BOTH end (and optionally start) produces a row', rows.length === 1);
    ok('that row is the candle one', rows[0].id === 'pointLightWallClip.candle');
  }

  // ======================================================================
  // Mirrored rows — depthProxyPoolStats / shaderRebuildStats / pipelineRebuildStats
  // ======================================================================
  {
    const rows = buildCacheRows({
      depthProxyPoolStats: {
        start: { hits: 10, misses: 2, evictions: 0, size: 6 },
        end: { hits: 40, misses: 6, evictions: 1, size: 6 },
      },
      shaderRebuildStats: { installed: true, calls: 50, hits: 48, misses: 2, labels: [] },
      pipelineRebuildStats: { installed: true, calls: 50, hits: 49, misses: 1, labels: [] },
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    ok('depth-proxy pool is mirrored as one row', !!byId.depthProxyMaterialPool);
    ok('depth-proxy pool hits is the window delta (40-10=30)', byId.depthProxyMaterialPool.hits === 30);
    ok('shader node-builder cache is mirrored', !!byId.shaderNodeBuilderCache);
    ok(
      'shader node-builder cache reads the probe totals directly (already a delta, no start/end pairing)',
      byId.shaderNodeBuilderCache.hits === 48
    );
    ok('pipeline cache is mirrored', !!byId.shaderPipelineCache);
    ok(
      'an uninstalled probe (installed:false) produces no mirrored row, not a row full of zeros',
      buildCacheRows({ shaderRebuildStats: { installed: false, calls: 0, hits: 0, misses: 0, labels: [] } }).length ===
        0
    );
  }

  // ======================================================================
  // Mirrored rows — passSlotStats (frame-profiler's own passId→slot Map)
  // ======================================================================
  {
    const rows = buildCacheRows({ passSlotStats: { slots: 80, declaredCount: 60, passSlotsUsed: 14 } });
    const r = rows.find((x) => x.id === 'framePassSlotAllocator');
    ok('pass-slot allocator is mirrored as one row', !!r);
    ok('pass-slot allocator size is passSlotsUsed (14)', r.size === 14);
    ok('pass-slot allocator capacity is slots-declaredCount (80-60=20)', r.capacity === 20);
    ok(
      'pass-slot allocator has no hits/misses — no counter exists on the get-or-create branch',
      r.hits === null && r.misses === null
    );
    ok(
      'passSlotStats:null (harness has no readPassSlotStats) produces no row',
      buildCacheRows({ passSlotStats: null }).every((x) => x.id !== 'framePassSlotAllocator')
    );
  }

  // ======================================================================
  // Mirrored rows — windowSurfacesByFloor, from the SAME windowDiagnostics
  // array that already feeds the window-surface-composition finding
  // ======================================================================
  {
    const rows = buildCacheRows({
      windowDiagnostics: [
        { floorIndex: 0, visible: true, sceneChildCount: 1, sceneChildren: [] },
        { floorIndex: 2, visible: false, sceneChildCount: 1, sceneChildren: [] },
      ],
    });
    const r = rows.find((x) => x.id === 'windowSurfacesByFloor');
    ok('windowSurfacesByFloor is mirrored as one row', !!r);
    ok('windowSurfacesByFloor is owned by window', r.ownerEffectId === 'window');
    ok('windowSurfacesByFloor.size is the per-floor array length (2)', r.size === 2);
    ok(
      'an empty windowDiagnostics array (nothing synced yet) still produces a row with size 0 — a real fact, not an absence',
      buildCacheRows({ windowDiagnostics: [] }).find((x) => x.id === 'windowSurfacesByFloor')?.size === 0
    );
    ok(
      'windowDiagnostics:null (harness has no readWindowDiagnostics) produces no row',
      buildCacheRows({ windowDiagnostics: null }).every((x) => x.id !== 'windowSurfacesByFloor')
    );
  }

  // ======================================================================
  // Mirrored rows — windowMaskReloadGate, summed (LIFETIME, not windowed)
  // across the same windowDiagnostics array
  // ======================================================================
  {
    const rows = buildCacheRows({
      windowDiagnostics: [
        { floorIndex: 0, maskReloadGate: { hits: 400, misses: 1 } },
        { floorIndex: 2, maskReloadGate: { hits: 120, misses: 2 } },
      ],
    });
    const r = rows.find((x) => x.id === 'windowMaskReloadGate');
    ok('windowMaskReloadGate is mirrored as one row', !!r);
    ok('windowMaskReloadGate is owned by window', r.ownerEffectId === 'window');
    ok('windowMaskReloadGate.hits is summed across floors (400+120=520)', r.hits === 520);
    ok('windowMaskReloadGate.misses is summed across floors (1+2=3)', r.misses === 3);
    ok(
      'a floor entry missing maskReloadGate entirely contributes 0, not a crash',
      buildCacheRows({ windowDiagnostics: [{ floorIndex: 0 }] }).find((x) => x.id === 'windowMaskReloadGate').hits === 0
    );
  }

  // ======================================================================
  // pointLightMeshPools — ONE raw object fans out into THREE rows
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: {
          pointLightMeshPools: {
            lightMeshes: { hits: 10, misses: 2, size: 8 },
            illumBuckets: { hits: 0, misses: 0, size: 0 },
            colorBuckets: { hits: 0, misses: 0, size: 0 },
          },
        },
        end: {
          pointLightMeshPools: {
            lightMeshes: { hits: 5000, misses: 3, size: 12 },
            illumBuckets: { hits: 200, misses: 4, size: 4 },
            colorBuckets: { hits: 150, misses: 3, size: 3 },
          },
        },
      },
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    ok(
      'all three point-light mesh pool rows are present',
      ['lightMeshes', 'illumBuckets', 'colorBuckets'].every((id) => byId[id])
    );
    ok('lightMeshes.hits is the window delta (5000-10=4990)', byId.lightMeshes.hits === 4990);
    ok('lightMeshes.misses is the window delta (3-2=1)', byId.lightMeshes.misses === 1);
    ok('lightMeshes.size is the END snapshot (12), not a delta', byId.lightMeshes.size === 12);
    ok("illumBuckets is derived from its OWN counters, not lightMeshes'", byId.illumBuckets.hits === 200);
    ok('colorBuckets is a SEPARATE registry from illumBuckets', byId.colorBuckets.hits !== byId.illumBuckets.hits);
  }

  // ======================================================================
  // vtMeshPools — regionMeshes / occlusionDiscs / itemStates
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: {
          vtMeshPools: {
            regionMeshes: { hits: 0, misses: 0, size: 0 },
            occlusionDiscs: { hits: 0, misses: 0, size: 0 },
            itemStates: { hits: 0, misses: 0, size: 0 },
          },
        },
        end: {
          vtMeshPools: {
            regionMeshes: { hits: 900, misses: 4, size: 4 },
            occlusionDiscs: { hits: 300, misses: 6, size: 6 },
            itemStates: { hits: 8000, misses: 42, size: 42 },
          },
        },
      },
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    ok(
      'all three vt mesh pool rows are present',
      ['regionMeshes', 'occlusionDiscs', 'itemStates'].every((id) => byId[id])
    );
    ok(
      'itemStates.misses is the most expensive of the three — the full async load chain',
      byId.itemStates.misses === 42
    );
    ok(
      'itemStates carries a note explaining why misses are the expensive outcome',
      byId.itemStates.note.includes('expensive')
    );
  }

  // ======================================================================
  // doorPools — doorTextureCache / doorLeaves
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: {
          doorPools: {
            doorTextureCache: { hits: 0, misses: 0, size: 0 },
            doorLeaves: { hits: 0, misses: 0, size: 0 },
          },
        },
        end: {
          doorPools: {
            doorTextureCache: { hits: 600, misses: 3, size: 3 },
            doorLeaves: { hits: 580, misses: 5, size: 5 },
          },
        },
      },
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    ok(
      'both door pool rows are present',
      ['doorTextureCache', 'doorLeaves'].every((id) => byId[id])
    );
    ok('doorTextureCache.misses is the window delta (3-0=3)', byId.doorTextureCache.misses === 3);
    ok('doorLeaves is derived from its OWN counters (5-0=5)', byId.doorLeaves.misses === 5);
  }

  // ======================================================================
  // buildSimplePoolRows — a sub-pool absent from a partial raw shape is
  // skipped, not crashed on or reported as zero (same doctrine as
  // pointLightWallClip's own partial-shape test above)
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { doorPools: { doorTextureCache: { hits: 0, misses: 0, size: 0 } } },
        end: { doorPools: { doorTextureCache: { hits: 10, misses: 1, size: 1 } } },
      },
    });
    ok('only the sub-pool actually present in BOTH end (and optionally start) produces a row', rows.length === 1);
    ok('that row is doorTextureCache', rows[0].id === 'doorTextureCache');
  }

  // ======================================================================
  // pyramidStore — IndexedDB page-blob persistence, a plain single-key adapter
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { pyramidStore: { hits: 40, misses: 6, writes: 6, writeFailures: 0 } },
        end: { pyramidStore: { hits: 9000, misses: 8, writes: 8, writeFailures: 0 } },
      },
    });
    const r = rows.find((x) => x.id === 'pyramidStore');
    ok('pyramidStore produces a row', !!r);
    ok('pyramidStore.hits is the window delta (9000-40=8960)', r.hits === 8960);
    ok('pyramidStore.misses is the window delta (8-6=2)', r.misses === 2);
    ok('a healthy persisted-page hit rate reads very high', r.hitRatePct > 99);
  }

  // ======================================================================
  // describeRenderMode — diag/render-fallback.js's own diagnostic cache
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { describeRenderMode: { hits: 20, misses: 5 } },
        end: { describeRenderMode: { hits: 400, misses: 8 } },
      },
    });
    const r = rows.find((x) => x.id === 'describeRenderMode');
    ok('describeRenderMode produces a row', !!r);
    ok('describeRenderMode.hits is the window delta (400-20=380)', r.hits === 380);
    ok('describeRenderMode.misses is the window delta (8-5=3)', r.misses === 3);
  }

  // ======================================================================
  // anchorMarkerPool / anchorViewMarkerPool — TWO separate marker Maps, two
  // separate rows, derived from their own separate counters
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { anchorMarkerPool: { hits: 0, misses: 3 }, anchorViewMarkerPool: { hits: 0, misses: 7 } },
        end: { anchorMarkerPool: { hits: 900, misses: 3 }, anchorViewMarkerPool: { hits: 400, misses: 9 } },
      },
    });
    const place = rows.find((x) => x.id === 'anchorMarkerPool');
    const view = rows.find((x) => x.id === 'anchorViewMarkerPool');
    ok('anchorMarkerPool produces a row', !!place);
    ok('anchorViewMarkerPool produces a row', !!view);
    ok('anchorMarkerPool.hits is its OWN delta (900-0=900)', place.hits === 900);
    ok("anchorViewMarkerPool.misses is its OWN delta (9-7=2), not anchorMarkerPool's", view.misses === 2);
  }

  // ======================================================================
  // paintModeGridCache — ONE raw object (prefixed fields) fans into TWO rows
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { paintModeGridCache: { canvasHits: 0, canvasMisses: 2, imageDataHits: 0, imageDataMisses: 3 } },
        end: { paintModeGridCache: { canvasHits: 500, canvasMisses: 2, imageDataHits: 480, imageDataMisses: 5 } },
      },
    });
    const canvas = rows.find((x) => x.id === 'paintModeGridCanvas');
    const imgData = rows.find((x) => x.id === 'paintModeGridImageData');
    ok('paintModeGridCanvas produces a row', !!canvas);
    ok('paintModeGridImageData produces a row', !!imgData);
    ok('paintModeGridCanvas.hits is the canvasHits delta (500-0=500)', canvas.hits === 500);
    ok('paintModeGridCanvas.misses is the canvasMisses delta (2-2=0) — no resize this window', canvas.misses === 0);
    ok(
      'paintModeGridImageData.misses is the imageDataMisses delta (5-3=2) — a resize DID happen',
      imgData.misses === 2
    );
    ok(
      'a canvas hit (0 misses) can pair with an ImageData miss (2 misses) — different counters, proven by this window',
      canvas.misses !== imgData.misses
    );
  }

  // ======================================================================
  // maskDiscovery — a ONE-SHOT summary, NOT delta'd (start is ignored)
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        // A deliberately DIFFERENT start value proves it is genuinely ignored,
        // not just coincidentally byte-identical to end.
        start: { maskDiscovery: { method: 'listing', probesAttempted: 999, floorsDiscovered: 1, floorsWithMasks: 0 } },
        end: {
          maskDiscovery: { method: 'listing', probesAttempted: 0, floorsDiscovered: 5, floorsWithMasks: 4 },
        },
      },
    });
    const r = rows.find((x) => x.id === 'maskDiscovery');
    ok('maskDiscovery produces a row', !!r);
    ok('maskDiscovery.size is floorsWithMasks from END, not start (4, not 0)', r.size === 4);
    ok('maskDiscovery.capacity is floorsDiscovered from END (5)', r.capacity === 5);
    ok('maskDiscovery.hits is null — no ongoing hit/miss pair exists for a one-shot cache', r.hits === null);
    ok('maskDiscovery.misses is null for the same reason', r.misses === null);
    ok(
      'maskDiscovery:null (discovery never ran) produces no row',
      buildCacheRows({ cacheStats: { start: {}, end: { maskDiscovery: null } } }).every((x) => x.id !== 'maskDiscovery')
    );
  }

  // ======================================================================
  // pixiProxy — MSA's OWN write-attempt outcome, never framed as a rate
  // against Foundry's PIXI.Assets.cache
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { pixiProxy: { registered: 0, alreadyCached: 0, skippedTooSmall: 0, unavailable: 0 } },
        end: { pixiProxy: { registered: 2, alreadyCached: 40, skippedTooSmall: 3, unavailable: 0 } },
      },
    });
    const r = rows.find((x) => x.id === 'pixiProxy');
    ok('pixiProxy produces a row', !!r);
    ok('pixiProxy.hits is the alreadyCached delta (40-0=40)', r.hits === 40);
    ok('pixiProxy.misses is the registered delta (2-0=2)', r.misses === 2);
    ok(
      'pixiProxy carries a note explicitly disclaiming ownership of PIXI.Assets.cache lookups',
      r.note.includes('does not') || r.note.toLowerCase().includes('cannot see')
    );
  }

  // ======================================================================
  // frame-graph — DELIBERATELY absent: zero live callers, no adapter exists
  // for it at all, so no combination of inputs can ever produce this row
  // ======================================================================
  {
    const rows = buildCacheRows({
      cacheStats: {
        start: { frameGraph: { pooled: 0 } },
        end: { frameGraph: { pooled: 3 } },
      },
    });
    ok(
      'an unrecognized raw key (frameGraph) produces no row for it — there is no adapter to match it',
      rows.every((r) => r.id !== 'frameGraph')
    );
  }

  // ======================================================================
  // findLowHitRateCaches — the finding's own filter logic
  // ======================================================================
  {
    const rows = [
      { id: 'a', label: 'A', hits: 2, misses: 8, hitRatePct: 20 }, // low rate, enough samples
      { id: 'b', label: 'B', hits: 99, misses: 1, hitRatePct: 99 }, // healthy
      { id: 'c', label: 'C', hits: 1, misses: 1, hitRatePct: 50 }, // low samples — must not fire
      { id: 'd', label: 'D', hits: null, misses: null, hitRatePct: null }, // unmeasurable — must not fire
    ];
    const flagged = findLowHitRateCaches(rows);
    ok('exactly one cache is flagged', flagged.length === 1);
    ok('the flagged one is the genuinely low-rate, well-sampled cache', flagged[0].id === 'a');
    ok(
      'a cache with too few total samples is never flagged regardless of its rate',
      !flagged.some((r) => r.id === 'c')
    );
    ok(
      'a cache with a null hitRatePct is never flagged as "low" — null is an absence, not a bad number',
      !flagged.some((r) => r.id === 'd')
    );
    ok(
      'a custom minRatePct/minSamples threshold is honoured',
      findLowHitRateCaches(rows, { minRatePct: 10, minSamples: 5 }).length === 0
    );
  }
}
