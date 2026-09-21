/**
 * Node verification for diag/load-report.js (mythica-machina-press#400).
 *
 * Fixtures are hand-built `getLoadingScreenState()`-shaped objects rather than
 * a real load — this module is pure and must not need a DOM, a clock, or a
 * scene to prove its own arithmetic and its own honesty rules.
 */
import { buildLoadReport } from '../load-report.js';
import { LOAD_PHASES } from '../../ui/load-progress.js';

export function run(t) {
  const { ok } = t;

  // --- NO DATA AT ALL --------------------------------------------------------
  {
    const r = buildLoadReport({});
    ok('no state at all reads as no-data, not a crash', r.status === 'no-data');
    ok('no-data still explains itself', typeof r.note === 'string' && r.note.length > 0);

    const r2 = buildLoadReport({ showing: false, current: null, lastLoad: null });
    ok('an explicit empty state also reads as no-data', r2.status === 'no-data');
  }

  // --- METHODOLOGY IS ALWAYS PRESENT ------------------------------------------
  {
    const r = buildLoadReport({});
    ok(
      'the methodology note is always included, so a pasted report is not read out of context',
      typeof r.methodology === 'string' && /settled/i.test(r.methodology)
    );
  }

  // --- IN-PROGRESS: the freeze-in-progress case this feature exists for ------
  {
    const state = {
      showing: true,
      current: {
        elapsedMs: 20000,
        title: 'Warming up',
        stallNote: null,
        blockers: ['GPU shader pipelines still compiling (1)'],
      },
      currentPhases: [
        { phase: LOAD_PHASES.SCENE, startMs: 0, endMs: 10, durMs: 10 },
        { phase: LOAD_PHASES.ART, startMs: 10, endMs: 4000, durMs: 3990 },
        { phase: LOAD_PHASES.WARMING, startMs: 4000, endMs: null, durMs: null },
      ],
      currentBlockerDurationsMs: {
        [LOAD_PHASES.WARMING]: { pipelineCompiles: { label: 'GPU shader pipelines still compiling', ms: 800 } },
      },
      lastLoad: null,
    };
    const r = buildLoadReport(state);
    ok('a load in flight reports in-progress, not complete', r.status === 'in-progress');
    ok('elapsed-so-far is surfaced', r.elapsedMsSoFar === 20000);
    ok('all three phases are present', r.phases.length === 3);

    const warming = r.phases.find((p) => p.id === LOAD_PHASES.WARMING);
    ok('the open phase is flagged as still running', warming.stillRunning === true);
    ok('the open phase gets a DERIVED so-far duration, not null', warming.durMs === 20000 - 4000);
    ok('a still-running phase says so in its own note', /so far|still running/i.test(warming.note));

    ok('the open, still-running phase can win the ranking', r.topContributorSoFar?.id === LOAD_PHASES.WARMING);
    ok('the verdict says "so far" for an in-progress top contributor', /so far/.test(r.topContributorSoFar.note));

    ok('the live warming breakdown is present', r.warmingBreakdownSoFar?.entries?.length === 1);
    ok('...with the right cause named', r.warmingBreakdownSoFar.entries[0].key === 'pipelineCompiles');
    ok('...and a real ms figure, not a guess', r.warmingBreakdownSoFar.entries[0].ms === 800);
  }

  // --- COMPLETE: a finished load, WARMING dominated by two overlapping causes -
  {
    const lastLoad = {
      sceneId: 'sceneA',
      sceneName: 'Town River Bridge',
      totalMs: 20000,
      worstStallMs: 0,
      forcedReveal: false,
      unfinished: [],
      error: null,
      phases: [
        { phase: LOAD_PHASES.SCENE, startMs: 0, endMs: 10, durMs: 10 },
        { phase: LOAD_PHASES.ART, startMs: 10, endMs: 4000, durMs: 3990 },
        { phase: LOAD_PHASES.FIRST_FRAME, startMs: 4000, endMs: 4180, durMs: 180 },
        { phase: LOAD_PHASES.WARMING, startMs: 4180, endMs: 20000, durMs: 15820 },
      ],
      blockerDurationsMs: {
        [LOAD_PHASES.WARMING]: {
          pipelineCompiles: { label: 'GPU shader pipelines still compiling', ms: 12000 },
          bcCompressOutstanding: { label: 'textures still being GPU-compressed', ms: 9000 },
        },
      },
    };
    const r = buildLoadReport({ showing: false, current: null, currentPhases: null, lastLoad });
    ok('a clean finish reports complete', r.status === 'complete');
    ok('total is the real total', r.totalMs === 20000);
    ok('no stall → no stall note', r.worstStallNote === null);

    ok('WARMING is correctly identified as the biggest contributor', r.topContributor.id === LOAD_PHASES.WARMING);
    ok('...with a real percentage of the whole load', r.topContributor.pctOfTotal === 79.1);
    ok('a finished top contributor does not say "so far"', !/so far/.test(r.topContributor.note));

    const entries = r.warmingBreakdown.entries;
    ok(
      'breakdown is sorted worst-first',
      entries[0].key === 'pipelineCompiles' && entries[1].key === 'bcCompressOutstanding'
    );
    ok('the honesty note calls out overlap', /overlap/i.test(r.warmingBreakdown.note));
    const summed = entries.reduce((a, e) => a + e.ms, 0);
    ok(
      'entries are allowed to sum PAST the phase\'s own duration — that is what "can overlap" means, proven, not just claimed',
      summed > 15820
    );
  }

  // --- FORCED REVEAL is not a clean completion, and must not read as one -----
  {
    const lastLoad = {
      sceneId: 's',
      sceneName: 'Stalled Scene',
      totalMs: 30000,
      worstStallMs: 900,
      forcedReveal: true,
      unfinished: ['map layers still loading (2)'],
      error: null,
      phases: [{ phase: LOAD_PHASES.WARMING, startMs: 0, endMs: 30000, durMs: 30000 }],
      blockerDurationsMs: {},
    };
    const r = buildLoadReport({ showing: false, lastLoad });
    ok('a timed-out reveal is its own status, not "complete"', r.status === 'forced-reveal');
    ok('it keeps naming what was unfinished', r.unfinishedWhenRevealed.length === 1);
    ok('a real stall produces a stall note', /froze/.test(r.worstStallNote));
  }

  // --- FAILED load -------------------------------------------------------------
  {
    const lastLoad = {
      sceneId: 's',
      sceneName: 'Broken Scene',
      totalMs: 800,
      worstStallMs: 0,
      forcedReveal: false,
      unfinished: [],
      error: 'the art 404ed',
      phases: [{ phase: LOAD_PHASES.ART, startMs: 0, endMs: 800, durMs: 800 }],
      blockerDurationsMs: {},
    };
    const r = buildLoadReport({ showing: false, lastLoad });
    ok('a failed load reports failed, not complete', r.status === 'failed');
    ok('the real error message is surfaced', r.error === 'the art 404ed');
  }

  // --- no phase has a measurable duration -> no fabricated verdict -----------
  {
    const lastLoad = {
      sceneId: 's',
      sceneName: 'Unmeasured',
      totalMs: 100,
      worstStallMs: 0,
      forcedReveal: false,
      unfinished: [],
      error: null,
      phases: [{ phase: LOAD_PHASES.SCENE, startMs: null, endMs: null, durMs: null, note: 'no clock was supplied' }],
      blockerDurationsMs: {},
    };
    const r = buildLoadReport({ showing: false, lastLoad });
    ok('with nothing measurable, there is no top contributor rather than a guessed one', r.topContributor === null);
    ok('and no warming breakdown fabricated out of nothing', r.warmingBreakdown === null);
  }

  // --- COMPILE TIME: the one measurement that survives a real freeze ---------
  // (mythica-machina-press#400 follow-up — the report field this whole round
  // exists for.)
  {
    const lastLoad = {
      sceneId: 's',
      sceneName: 'Big Bank',
      totalMs: 68216,
      worstStallMs: 43517,
      forcedReveal: true,
      unfinished: [],
      error: null,
      phases: [{ phase: LOAD_PHASES.WARMING, startMs: 20290, endMs: 68216, durMs: 47926 }],
      blockerDurationsMs: {},
    };
    const diagnostics = {
      shaderRebuild: {
        installed: false,
        calls: 40,
        hits: 38,
        misses: 2,
        totalMissMs: 1200,
        worstMissMs: 900,
        labels: [],
      },
      pipelineRebuild: {
        installed: false,
        calls: 12,
        hits: 11,
        misses: 1,
        totalMissMs: 42000,
        worstMissMs: 42000,
        labels: [{ label: 'floor/WallTile', misses: 1, ms: 42000, worstMs: 42000 }],
      },
    };
    const r = buildLoadReport({ showing: false, lastLoad }, diagnostics);
    ok(
      'both probes are surfaced',
      r.compileTime.shaderRebuild.measured === true && r.compileTime.pipelineRebuild.measured === true
    );
    ok('shader rebuild time is real, not just a count', r.compileTime.shaderRebuild.totalMs === 1200);
    ok('pipeline rebuild time is real, not just a count', r.compileTime.pipelineRebuild.totalMs === 42000);
    ok('the worst single pipeline compile is surfaced', r.compileTime.pipelineRebuild.worstMs === 42000);
    ok('the offending render object is named', r.compileTime.pipelineRebuild.topLabels[0].label === 'floor/WallTile');
    ok('the two are combined into one headline figure', r.compileTime.combinedMs === 43200);
    ok(
      'a compile total close to the worst stall says so — the direct evidence this report exists to surface',
      /strong candidate/.test(r.compileTime.correlationNote)
    );
  }
  {
    // A small compile total beside a big stall must NOT be oversold as the cause.
    const lastLoad = {
      sceneId: 's',
      sceneName: 's',
      totalMs: 10000,
      worstStallMs: 8000,
      forcedReveal: false,
      unfinished: [],
      error: null,
      phases: [{ phase: LOAD_PHASES.WARMING, startMs: 0, endMs: 10000, durMs: 10000 }],
      blockerDurationsMs: {},
    };
    const diagnostics = {
      shaderRebuild: { installed: false, calls: 5, hits: 5, misses: 0, totalMissMs: 0, worstMissMs: 0, labels: [] },
      pipelineRebuild: { installed: false, calls: 5, hits: 5, misses: 0, totalMissMs: 0, worstMissMs: 0, labels: [] },
    };
    const r = buildLoadReport({ showing: false, lastLoad }, diagnostics);
    ok('zero misses is a real, measured zero — not null', r.compileTime.combinedMs === 0);
    ok(
      'a near-zero compile total points elsewhere for the freeze',
      /look elsewhere/.test(r.compileTime.correlationNote)
    );
  }
  {
    // A probe that could not find what it needed to wrap is UNMEASURED, not a
    // silent zero — collapsing the two would let a broken probe read as a
    // healthy load (feedback_instruments_must_not_lie).
    const lastLoad = {
      sceneId: 's',
      sceneName: 's',
      totalMs: 1000,
      worstStallMs: 0,
      forcedReveal: false,
      unfinished: [],
      error: null,
      phases: [],
      blockerDurationsMs: {},
    };
    const diagnostics = {
      shaderRebuild: { skipped: true, armed: false, reason: 'renderer._nodes is not present' },
      pipelineRebuild: null,
    };
    const r = buildLoadReport({ showing: false, lastLoad }, diagnostics);
    ok('an unmeasured probe reports measured:false, not a fake zero', r.compileTime.shaderRebuild.measured === false);
    ok('...and keeps the reason', /renderer\._nodes/.test(r.compileTime.shaderRebuild.reason));
    ok('a probe with no data at all is absent, not a fabricated entry', r.compileTime.pipelineRebuild === null);
    ok('with nothing measured, there is no combined figure', r.compileTime.combinedMs === null);
  }
  {
    // No diagnostics bundle at all (e.g. an older session, or the arm/disarm
    // bracket never ran) must not throw and must not fabricate a section.
    const lastLoad = {
      sceneId: 's',
      sceneName: 's',
      totalMs: 1000,
      worstStallMs: 0,
      forcedReveal: false,
      unfinished: [],
      error: null,
      phases: [],
      blockerDurationsMs: {},
    };
    const r = buildLoadReport({ showing: false, lastLoad });
    ok('no diagnostics -> no compileTime section, not a crash', r.compileTime === null);
    ok('no diagnostics -> no cacheHealth section either', r.cacheHealth === null);
  }

  // --- CACHE HEALTH: "is something being recomputed that should be cached" ---
  {
    const cacheSnapshot = {
      start: {
        pyramidStore: { hits: 0, misses: 0 },
        vtDecodePool: { idbHits: 0, sourcesDecoded: 0 },
        vtPageCache: { misses: 0, evictions: 0, residentPages: 0, capacityPages: 512 },
      },
      end: {
        // A near-0% hit rate on IndexedDB page persistence — the author's own
        // hypothesis ("recomputing something that doesn't need to be").
        pyramidStore: { hits: 1, misses: 9 },
        vtDecodePool: { idbHits: 40, sourcesDecoded: 4 },
        vtPageCache: { misses: 12, evictions: 3, residentPages: 480, capacityPages: 512 },
      },
    };
    const lastLoad = {
      sceneId: 's',
      sceneName: 's',
      totalMs: 1000,
      worstStallMs: 0,
      forcedReveal: false,
      unfinished: [],
      error: null,
      phases: [],
      blockerDurationsMs: {},
    };
    const r = buildLoadReport({ showing: false, lastLoad }, { cacheSnapshot });
    ok('the relevant art-streaming caches are all present', r.cacheHealth.rows.length === 3);
    ok(
      'a cache with no hits counter at all reports null, never a fabricated rate',
      r.cacheHealth.rows.find((row) => row.id === 'vtPageCache').hitRatePct === null
    );
    ok(
      'the low-hit-rate cache is named directly — a verdict this tool can compute must not be left as an exercise',
      r.cacheHealth.lowHitRateCacheIds.includes('pyramidStore')
    );
    ok(
      'a healthy cache is NOT flagged alongside the bad one',
      !r.cacheHealth.lowHitRateCacheIds.includes('vtDecodePool')
    );
  }
  {
    const lastLoad = {
      sceneId: 's',
      sceneName: 's',
      totalMs: 1000,
      worstStallMs: 0,
      forcedReveal: false,
      unfinished: [],
      error: null,
      phases: [],
      blockerDurationsMs: {},
    };
    const r = buildLoadReport({ showing: false, lastLoad }, { cacheSnapshot: null });
    ok('a missing snapshot is absent, not an empty-but-present section', r.cacheHealth === null);
  }

  // --- ZONE BREAKDOWN: what actually filled the unattributed gap -------------
  // (mythica-machina-press#400, second follow-up — the live Big Bank capture
  // where compileTime measured only ~1.2s but FIRST_FRAME alone took 33.5s.)
  {
    const lastLoad = {
      sceneId: 's',
      sceneName: 's',
      totalMs: 1000,
      worstStallMs: 0,
      forcedReveal: false,
      unfinished: [],
      error: null,
      phases: [],
      blockerDurationsMs: {},
    };
    // A steady-state zone with a HIGH per-frame average but a LOW worst single
    // hit, beside a sparse/bake-style zone with a tiny average (many frames in
    // the denominator) but one huge occurrence — the exact case a per-frame
    // mean would hide.
    const zoneRows = [
      { id: 'pass.light.accumulate', cpuMsPerFrame: 2.5, cpuMaxMs: 4, gpuMsPerFrame: 3, gpuMaxMs: 5, count: 500 },
      { id: 'sims.windBake', cpuMsPerFrame: 0.02, cpuMaxMs: 9800, gpuMsPerFrame: null, gpuMaxMs: null, count: 1 },
      { id: 'residency.itemLoad', cpuMsPerFrame: 0.1, cpuMaxMs: 120, gpuMsPerFrame: null, gpuMaxMs: null, count: 40 },
      { id: 'nothing-happened', cpuMsPerFrame: 0, cpuMaxMs: 0, gpuMsPerFrame: 0, gpuMaxMs: 0, count: 0 },
    ];
    const r = buildLoadReport({ showing: false, lastLoad }, { zoneRows });
    ok(
      'the once-off bake is ranked first, by its single worst hit, not its tiny per-frame average',
      r.zoneBreakdown.topZones[0].id === 'sims.windBake'
    );
    ok('...with the real worst-case figure surfaced', r.zoneBreakdown.topZones[0].worstMs === 9800);
    ok(
      'a zone with genuinely zero cost is dropped, not padding the list',
      !r.zoneBreakdown.topZones.some((z) => z.id === 'nothing-happened')
    );
    ok('the honesty note explains the ranking basis', /worst/i.test(r.zoneBreakdown.note));
  }
  {
    // Capped, not truncated silently past the point of usefulness.
    const lastLoad = {
      sceneId: 's',
      sceneName: 's',
      totalMs: 1000,
      worstStallMs: 0,
      forcedReveal: false,
      unfinished: [],
      error: null,
      phases: [],
      blockerDurationsMs: {},
    };
    const zoneRows = Array.from({ length: 20 }, (_, i) => ({
      id: `zone${i}`,
      cpuMsPerFrame: 1,
      cpuMaxMs: 20 - i,
      gpuMsPerFrame: null,
      gpuMaxMs: null,
      count: 1,
    }));
    const r = buildLoadReport({ showing: false, lastLoad }, { zoneRows });
    ok('the list is capped to a readable top slice', r.zoneBreakdown.topZones.length === 10);
    ok('...and it is still the ACTUAL worst ten, not just the first ten', r.zoneBreakdown.topZones[0].id === 'zone0');
  }
  {
    const lastLoad = {
      sceneId: 's',
      sceneName: 's',
      totalMs: 1000,
      worstStallMs: 0,
      forcedReveal: false,
      unfinished: [],
      error: null,
      phases: [],
      blockerDurationsMs: {},
    };
    const r = buildLoadReport({ showing: false, lastLoad }, { zoneRows: null });
    ok('no zone data at all is absent, not an empty-but-present section', r.zoneBreakdown === null);
  }
  {
    // The in-progress branch has no live path for this yet (see load-report.js's
    // own comment) — must read null even if a stale zoneRows happens to be
    // sitting in `diagnostics` from a PREVIOUS completed load.
    const state = {
      showing: true,
      current: { elapsedMs: 5000, title: 'Streaming map art', stallNote: null, blockers: [] },
      currentPhases: [{ phase: LOAD_PHASES.ART, startMs: 0, endMs: null, durMs: null }],
      currentBlockerDurationsMs: {},
      lastLoad: null,
    };
    const staleDiagnostics = { zoneRows: [{ id: 'stale', cpuMsPerFrame: 1, cpuMaxMs: 5000, count: 1 }] };
    const r = buildLoadReport(state, staleDiagnostics);
    ok("in-progress never surfaces a previous load's zone data as if it were live", r.zoneBreakdown === null);
  }

  // --- THE WARM-UP'S OWN OUTCOME (mythica-machina-press#582) ---------------
  // A warm-up that throws compiles NOTHING and leaves every pipeline to
  // compile in front of the user — and used to be invisible in this report,
  // which is how #402 (a warm-up that failed on every single load) stayed
  // triaged as "purely cosmetic". These pin that it can never hide again.
  {
    const mkLast = (warmUp) =>
      buildLoadReport(
        {
          showing: false,
          current: null,
          lastLoad: {
            sceneName: 'S',
            totalMs: 1000,
            error: null,
            forcedReveal: false,
            unfinished: [],
            worstStallMs: 0,
            phases: [{ phase: LOAD_PHASES.ART, startMs: 0, endMs: 1000, durMs: 1000 }],
            blockerDurationsMs: {},
          },
        },
        { warmUp }
      );

    const threw = mkLast({ warmUpMs: null, warmUpPipelinesCreated: 3, shaderCompileMs: 10 });
    ok('a warm-up that threw is reported as NOT having run', threw.warmUp.ran === false);
    ok('...and says so in words a triager cannot mistake for cosmetic', /did not complete/i.test(threw.warmUp.note));

    const worked = mkLast({ warmUpMs: 420, warmUpPipelinesCreated: 12, shaderCompileMs: 30 });
    ok('a warm-up that ran reports its real cost', worked.warmUp.ran === true && worked.warmUp.ms === 420);
    ok('...and how many pipelines it moved behind the curtain', worked.warmUp.pipelinesCreated === 12);

    const nothingCompiled = mkLast({ warmUpMs: 5, warmUpPipelinesCreated: 0, shaderCompileMs: 0 });
    ok(
      'a warm-up that ran but compiled nothing is worded distinctly from one that threw',
      nothingCompiled.warmUp.ran === true && nothingCompiled.warmUp.note !== threw.warmUp.note
    );

    ok('no warm-up data at all is absent, never a fabricated success', mkLast(null).warmUp === null);
    // --- TEXTURE COMPRESSION HEALTH (mythica-machina-press#585) --------------
    // A BC worker that is unavailable makes every layer fall back to a RAW
    // texture — ~576MB vs ~144MB for a 12,000-square layer, uploaded on the main
    // thread. That is the leading suspect for the one long unexplained stall in
    // the live reports, and none of it reached this report before.
    {
      const mkC = (compression) =>
        buildLoadReport(
          {
            showing: false,
            current: null,
            lastLoad: {
              sceneName: 'S',
              totalMs: 1000,
              error: null,
              forcedReveal: false,
              unfinished: [],
              worstStallMs: 0,
              phases: [{ phase: LOAD_PHASES.ART, startMs: 0, endMs: 1000, durMs: 1000 }],
              blockerDurationsMs: {},
            },
          },
          { compression }
        );

      ok('absent compression data is absent, never a fabricated all-clear', mkC(null).compression === null);

      const broken = mkC({ worker: { workerCreated: false, unavailable: true, failed: 3, requests: 9 }, items: [] });
      ok('an unavailable worker is called out loudly', /NOT HEALTHY/.test(broken.compression.note));
      ok('...and names the raw-texture fallback as the cost', /RAW texture/.test(broken.compression.note));

      const healthy = mkC({
        worker: { workerCreated: true, unavailable: false, failed: 0, requests: 9, cached: 9 },
        applied: true,
        appliedItems: 4,
        itemCount: 4,
        estTextureVramMB: 512,
        items: [{ id: 'a', compressed: 'bc7', approxVramMB: 144 }],
      });
      ok('a healthy worker reads as healthy', /healthy/.test(healthy.compression.note));
      ok(
        '...and says its window is point-in-time, not a #583-style delta',
        /POINT-IN-TIME/.test(healthy.compression.note)
      );
      ok('...and carries the VRAM bill', healthy.compression.estTextureVramMB === 512);
      ok('...with no false fallback accusation', healthy.compression.fellBackItemIds.length === 0);

      const fellBack = mkC({
        worker: { workerCreated: true, unavailable: false, failed: 0, requests: 2 },
        items: [
          { id: 'ground', compressed: 'error:fellback', approxVramMB: 576 },
          { id: 'first', compressed: 'bc7', approxVramMB: 144 },
        ],
      });
      ok(
        'a per-item fallback is named even when the worker claims health',
        fellBack.compression.fellBackItemIds.join() === 'ground'
      );
      // A null `compressed` means "not reported". Inferring a fallback from an
      // absent field is how an instrument starts inventing findings — which is
      // exactly the mistake #584 was.
      const unknown = mkC({
        worker: { workerCreated: true, unavailable: false, failed: 0 },
        items: [{ id: 'x', compressed: null }],
      });
      ok(
        'an unreported compression state is NOT counted as a fallback',
        unknown.compression.fellBackItemIds.length === 0
      );
    }

    // THE UNPAUSE FIX'S RECEIPT. Pipelines#caches is ONE Map shared by render
    // and compute pipelines, so without a separate counter the sim kernels'
    // compiles would vanish into the draw warm-up's total and the claim would
    // be unfalsifiable.
    const withSims = mkLast({ warmUpMs: 400, warmUpPipelinesCreated: 12, warmUpSimPipelinesCreated: 5 });
    ok('sim-kernel compiles are counted separately from the draw warm-up', withSims.warmUp.simPipelinesCreated === 5);
    ok('...and are described as the unpause freeze being paid early', /unpause/i.test(withSims.warmUp.simNote));

    const noSims = mkLast({ warmUpMs: 400, warmUpPipelinesCreated: 12, warmUpSimPipelinesCreated: 0 });
    ok(
      'a sim warm-up that reached nothing says so, rather than reading as success',
      noSims.warmUp.simPipelinesCreated === 0 && /expected to persist/i.test(noSims.warmUp.simNote)
    );
    ok(
      'an unmeasured sim warm-up is worded differently again from a measured zero',
      mkLast({ warmUpMs: 400 }).warmUp.simNote !== noSims.warmUp.simNote
    );
  }
}
