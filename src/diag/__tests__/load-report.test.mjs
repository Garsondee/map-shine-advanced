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
}
