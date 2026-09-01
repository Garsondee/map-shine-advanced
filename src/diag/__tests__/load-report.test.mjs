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
}
