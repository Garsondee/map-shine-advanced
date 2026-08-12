/**
 * Node tests for perf-report.js — the report brain.
 *
 * These are not "does it produce an object" tests. Every block below pins one of
 * the five honesty rules in that file's header, because the failure mode of a
 * profiler is not a crash — it is a confident, wrong number that sends someone
 * optimising the wrong pass for a day.
 *
 * The two that have actually cost this project money elsewhere and are pinned
 * hardest: a fabricated 0 standing in for "not measured"
 * (feedback_instruments_must_not_lie), and a sum that double-counts because a
 * container and its contents were both included.
 */
import { BLOOM, CANDLE_FLAME, SPECULAR, SUN_SHADOWS, VEGETATION, WATER } from '../../effects/index.js';
import { EFFECT_ZONING, ZONES } from '../perf-zones.js';
// The REAL sweep producer. Imported so the report is contract-checked against
// what perf-lab actually emits, not against a fixture I wrote from memory.
import { summarizeSweep } from '../perf-lab.js';
import {
  AGREEMENT_TOLERANCE,
  COVERAGE_GOOD,
  COVERAGE_UNRELIABLE,
  HITCHES_KEPT,
  SHAPE_BUCKETS,
  annotatePassResiduals,
  attributeZonesToEffects,
  buildHistogram,
  buildPerfReport,
  buildZoneRows,
  classifyAgreement,
  classifyBottleneck,
  classifyTemporalShape,
  clockNoiseFloorMs,
  collapseInsignificant,
  compareToManifest,
  computeAttribution,
  condenseFrameHistory,
  deriveFindings,
  estimateSweepNoiseFloor,
  findHangs,
  statFrom,
  summariseFrameRate,
  summariseSamples,
  summarizeTierComparison,
} from '../perf-report.js';

const acc = (sumMs, count, maxMs) => ({ sumMs, count, maxMs });
const zs = (id, over = {}) => ({ id, cpu: null, gpu: null, drawCalls: null, triangles: null, ...over });

export function run(t) {
  const { ok } = t;

  // ======================================================================
  // RULE 1 — never 0 for "not measured"
  // ======================================================================
  {
    ok('statFrom on a zero-count accumulator is null, not a zero block', statFrom(acc(0, 0, 0), 100) === null);
    ok('statFrom on a null accumulator is null', statFrom(null, 100) === null);
    ok('statFrom on undefined is null', statFrom(undefined, 100) === null);

    const s = statFrom(acc(6, 3, 4), 300);
    ok('statFrom meanMs is per OCCURRENCE', s.meanMs === 2);
    ok('statFrom amortisedMsPerFrame is per FRAME', s.amortisedMsPerFrame === 0.02);
    ok('statFrom keeps the occurrence count beside the statistic', s.occurrences === 3);
    ok('statFrom keeps the peak', s.maxMs === 4);
    ok(
      'statFrom with 0 frames gives null amortised, not Infinity or 0',
      statFrom(acc(6, 3, 4), 0).amortisedMsPerFrame === null
    );

    ok(
      'summariseSamples on empty is all-null with sampleCount 0',
      (() => {
        const r = summariseSamples([]);
        return r.p50 === null && r.p95 === null && r.max === null && r.sampleCount === 0;
      })()
    );
    ok(
      'summariseSamples on a real series produces ordered percentiles',
      (() => {
        const r = summariseSamples([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]);
        return r.p50 <= r.p95 && r.p95 <= r.max && r.sampleCount === 10;
      })()
    );

    ok('condenseFrameHistory on empty is null, not an array of zeros', condenseFrameHistory([]) === null);
    ok('condenseFrameHistory on a non-array is null', condenseFrameHistory(null) === null);
    ok('buildHistogram on empty is null', buildHistogram([]) === null);
  }

  // ======================================================================
  // RULE 2 — print the residual, with the RIGHT nesting semantics per column
  // ======================================================================
  {
    // ⚠️ GPU IS EXCLUSIVE, CPU IS INCLUSIVE. Corrected 2026-07-27 from the first
    // live run, where every pass row showed `gpu: —` beside children with real
    // numbers. A timestamped render pass is attributed to the INNERMOST open
    // zone, so in a fully bracketed pass every draw belongs to a child and the
    // pass keeps nothing. Summing pass rows only — which is correct for CPU —
    // discarded nearly all the GPU time and would have reported coverage ~0.
    const frames = 100;
    const rows = buildZoneRows({
      zones: ZONES,
      frames,
      zoneStats: [
        // Fully bracketed: no GPU of its own, exactly as observed live.
        zs('pass.light.accumulate', { cpu: acc(200, 100, 3) }),
        zs('light.drawIllum', { gpu: acc(50, 100, 1) }), //        0.5 ms/frame
        zs('light.drawPointLights', { gpu: acc(100, 100, 2) }), // 1.0 ms/frame
        zs('sims.wind', { gpu: acc(30, 100, 1) }), //              0.3 ms/frame (pre-plan)
      ],
    });

    const att = computeAttribution({ frameGpuMs: 2.0, rows });
    ok('GPU attribution sums EVERY row, because the slices are disjoint', Math.abs(att.attributedGpuMs - 1.8) < 1e-9);
    ok(
      'a fully bracketed pass contributes no GPU of its own',
      rows.find((r) => r.id === 'pass.light.accumulate').gpuMs === null
    );
    ok('...which no longer zeroes the coverage', att.coverage > 0.85);
    ok('residual is printed', Math.abs(att.residualGpuMs - 0.2) < 1e-9);
    ok(
      'children are marked with their parent pass',
      rows.find((r) => r.id === 'light.drawIllum').parent === 'pass.light.accumulate'
    );
    ok('a pre-plan zone is top-level', rows.find((r) => r.id === 'sims.wind').parent === null);
  }

  {
    // A pass that DOES have un-bracketed draws of its own contributes them, and
    // they must not be lost either.
    const rows = buildZoneRows({
      zones: ZONES,
      frames: 100,
      zoneStats: [
        zs('pass.geometry.world', { gpu: acc(40, 100, 1) }), // 0.4 own
        zs('geometry.worldDraw', { gpu: acc(160, 100, 3) }), // 1.6 child
      ],
    });
    const att = computeAttribution({ frameGpuMs: 2.0, rows });
    ok("a pass's own un-bracketed GPU work is counted too", Math.abs(att.attributedGpuMs - 2.0) < 1e-9);
    ok('...giving full coverage when nothing is missing', att.coverage === 1);
    ok('...and a zero residual, which here is a MEASUREMENT not an absence', att.residualGpuMs === 0);
  }

  // ---- verdict bands, and the note changes with them -----------------------
  {
    const mk = (frameGpuMs, attributedMs) =>
      computeAttribution({
        frameGpuMs,
        rows: buildZoneRows({
          zones: ZONES,
          frames: 100,
          zoneStats: [zs('pass.geometry.world', { gpu: acc(attributedMs * 100, 100, 1) })],
        }),
      });

    ok(`coverage >= ${COVERAGE_GOOD} is 'good'`, mk(10, 9.5).verdict === 'good');
    ok(`coverage in [${COVERAGE_UNRELIABLE},${COVERAGE_GOOD}) is 'indicative'`, mk(10, 7).verdict === 'indicative');
    ok(`coverage < ${COVERAGE_UNRELIABLE} is 'unreliable'`, mk(10, 3).verdict === 'unreliable');
    ok('a good note does NOT tell you to distrust it', !mk(10, 9.5).note.includes('INDICATIVE'));
    ok('an indicative note redirects to the sweep', mk(10, 7).note.includes('sweep'));
    ok('an unreliable note says it is not a partition', mk(10, 3).note.includes('NOT trustworthy'));

    const none = computeAttribution({ frameGpuMs: null, rows: [] });
    ok("no GPU data verdicts 'unmeasured', not 'unreliable'", none.verdict === 'unmeasured');
    ok('no GPU data gives null coverage, never 0', none.coverage === null);
    ok('no GPU data gives null residual, never 0', none.residualGpuMs === null);
    ok('the unmeasured note calls it an ABSENCE', none.note.includes('ABSENCE'));
  }

  // ======================================================================
  // RULE 3 — sparse work is not a per-frame cost
  // ======================================================================
  {
    const rows = buildZoneRows({
      zones: ZONES,
      frames: 612,
      // Ran 3 times in 612 frames, 4.8ms each. A median over all frames is 0.
      zoneStats: [zs('light.sunShadowBake', { gpu: acc(14.4, 3, 5.4) })],
    });
    const bake = rows[0];
    ok('a bake zone is flagged sparse', bake.sparse === true);
    ok('a bake reports its true per-occurrence mean, not a per-frame median', bake.gpuMs.meanMs === 4.8);
    ok('a bake reports its peak', bake.gpuMs.maxMs === 5.4);
    ok('a bake amortises to a tiny per-frame number', bake.gpuMs.amortisedMsPerFrame < 0.03);
    ok('a bake keeps its occurrence count', bake.gpuMs.occurrences === 3);
    ok('occurrenceRate is the rate, not the count', Math.abs(bake.occurrenceRate - 3 / 612) < 1e-6);

    // And it must be excluded from the frame partition — an event zone is not
    // part of any frame and summing it in would inflate coverage.
    const withEvent = buildZoneRows({
      zones: ZONES,
      frames: 100,
      zoneStats: [
        zs('pass.geometry.world', { gpu: acc(100, 100, 2) }),
        zs('residency.pass', { cpu: acc(500, 5, 200) }),
      ],
    });
    const att = computeAttribution({ frameGpuMs: 2, rows: withEvent });
    ok('an event-cadence zone is excluded from frame attribution', Math.abs(att.attributedGpuMs - 1.0) < 1e-9);

    // A sparse zone is never collapsed away, however cheap it amortises to.
    const { kept } = collapseInsignificant(rows, { frameGpuMs: 100 });
    ok(
      'a sparse zone survives collapsing regardless of its amortised cost',
      kept.some((r) => r.id === 'light.sunShadowBake')
    );
  }

  // ======================================================================
  // RULE 4 — a clock cannot resolve what it cannot resolve
  // ======================================================================
  {
    ok('noise floor is resolution / sqrt(12n)', Math.abs(clockNoiseFloorMs(0.1, 600) - 0.1 / Math.sqrt(7200)) < 1e-12);
    ok('unknown resolution gives a null floor, not 0', clockNoiseFloorMs(null, 600) === null);
    ok('zero resolution gives a null floor', clockNoiseFloorMs(0, 600) === null);
    ok('zero samples gives a null floor', clockNoiseFloorMs(0.1, 0) === null);
    ok('more samples lowers the floor', clockNoiseFloorMs(0.1, 10000) < clockNoiseFloorMs(0.1, 100));

    // A 1ms-clamped clock (Firefox, not cross-origin-isolated) over 100 frames
    // has a floor of ~0.029ms; a 0.001ms mean is noise and must not get a number.
    const rows = buildZoneRows({
      zones: ZONES,
      frames: 100,
      clockResolutionMs: 1,
      zoneStats: [zs('tick.camera', { cpu: acc(0.1, 100, 1) })],
    });
    ok('a sub-noise-floor CPU mean is flagged', rows[0].belowClockResolution === true);
    ok('the floor itself is reported so the reader can check', rows[0].clockNoiseFloorMs > 0);

    const loud = buildZoneRows({
      zones: ZONES,
      frames: 100,
      clockResolutionMs: 1,
      zoneStats: [zs('tick.camera', { cpu: acc(400, 100, 8) })],
    });
    ok('a well-above-floor CPU mean is NOT flagged', loud[0].belowClockResolution === false);

    const unknown = buildZoneRows({
      zones: ZONES,
      frames: 100,
      zoneStats: [zs('tick.camera', { cpu: acc(0.1, 100, 1) })],
    });
    ok('with no measured resolution nothing is suppressed', unknown[0].belowClockResolution === false);
    ok('with no measured resolution the floor is null, not 0', unknown[0].clockNoiseFloorMs === null);
  }

  // ======================================================================
  // RULE 5 — sample, do not dump
  // ======================================================================
  {
    const many = Array.from({ length: 900 }, (_, i) => (i === 400 ? 168 : 8 + (i % 3)));
    const shape = condenseFrameHistory(many, { durationMs: 7500 });
    ok(`900 samples condense to exactly ${SHAPE_BUCKETS} numbers`, shape.worstGapMs.length === SHAPE_BUCKETS);
    ok('the shape keeps the spike (worst-per-bucket, not mean)', shape.worstGapMs.includes(168));
    ok('the shape reports its own bucket width', shape.bucketMs > 0);
    ok('the shape says what it is', shape.note.includes('SHAPE'));

    const few = condenseFrameHistory([5, 6, 7]);
    ok('fewer samples than buckets gives one bucket per sample, not padding', few.worstGapMs.length === 3);
    ok('a short series has no fabricated bucket width when duration is unknown', few.bucketMs === null);

    const hist = buildHistogram([5, 5, 12, 40, 200]);
    ok(
      'the histogram uses the flight recorder fps bands',
      hist.some((b) => b.label === '>120fps')
    );
    ok(
      'the histogram omits empty bands rather than printing zeros',
      hist.every((b) => b.frames > 0)
    );
    ok('the histogram percentages sum to ~100', Math.abs(hist.reduce((a, b) => a + b.percent, 0) - 100) < 0.5);
  }

  // ======================================================================
  // Declared cost vs measured — the loop that has never been closed
  // ======================================================================
  {
    ok('bloom declares a cost we can compare against', BLOOM.tiers[0].cost.estMsPerMp === 0.3);

    const within = compareToManifest(0.31, BLOOM);
    ok("measured near declared is 'within'", within.verdict === 'within');
    ok('the declared range is reported', within.declaredMaxMsPerMp === 0.3);
    ok('the declared cost classes come through', within.classes.includes('C2'));

    const over = compareToManifest(0.9, BLOOM);
    ok("measured 3x declared is 'over'", over.verdict === 'over');
    ok('the over note gives the ratio', over.ratioToDeclaredMax === 3);
    ok('the over note says the declaration has never been checked', over.note.includes('never been checked'));

    ok("measured far under declared is 'under'", compareToManifest(0.01, BLOOM).verdict === 'under');
    ok("no measurement is 'unmeasured', not 'within'", compareToManifest(null, BLOOM).verdict === 'unmeasured');
    ok("no tiers is 'undeclared'", compareToManifest(0.5, { tiers: [] }).verdict === 'undeclared');
    ok('undeclared reports null bounds, never 0', compareToManifest(0.5, {}).declaredMaxMsPerMp === null);

    // Multi-tier manifests compare against the RANGE, not a guessed tier.
    const twoTier = { tiers: [{ cost: { class: 'C1', estMsPerMp: 0.1 } }, { cost: { class: 'C4', estMsPerMp: 0.8 } }] };
    const r = compareToManifest(0.7, twoTier);
    ok('a multi-tier manifest reports min and max', r.declaredMinMsPerMp === 0.1 && r.declaredMaxMsPerMp === 0.8);
    ok('measured inside the tier range is within', r.verdict === 'within');
  }

  // ======================================================================
  // Method agreement — divergence is information, not an error
  // ======================================================================
  {
    ok('close values agree', classifyAgreement(1.0, 1.1, null) === 'agree');
    ok('far values with full coverage disagree', classifyAgreement(1.0, 3.0, { coverage: 'full' }) === 'disagree');
    ok(
      'far values with partial coverage are expected to diverge',
      classifyAgreement(1.0, 3.0, { coverage: 'partial' }) === 'diverge-expected'
    );
    ok('one missing side gives null, never a verdict', classifyAgreement(1.0, null, null) === null);
    ok('both missing gives null', classifyAgreement(null, null, null) === null);
    ok('both zero agrees rather than dividing by zero', classifyAgreement(0, 0, null) === 'agree');
    ok(
      `tolerance is ${AGREEMENT_TOLERANCE}`,
      classifyAgreement(1.0, 1.0 + AGREEMENT_TOLERANCE * 0.99, { coverage: 'full' }) === 'agree'
    );
  }

  // ======================================================================
  // Effect rollup — 'method' and 'whyNotZoned' carry the honesty
  // ======================================================================
  {
    const rows = buildZoneRows({
      zones: ZONES,
      frames: 100,
      zoneStats: [
        zs('bloom.bright', { gpu: acc(20, 100, 0.4) }),
        zs('bloom.downsample', { gpu: acc(60, 100, 0.9) }),
        zs('surface.specularDraw', { gpu: acc(150, 100, 2.2) }),
        zs('light.vegetationSync', { cpu: acc(40, 100, 0.9) }),
      ],
    });
    const effects = attributeZonesToEffects({
      rows,
      manifests: [BLOOM, SPECULAR, VEGETATION],
      effectZoning: EFFECT_ZONING,
      // THE REAL runSweep SHAPE — `{effects, configs, raw, summary}`, costs at
      // `summary.perEffect[].costMs`. Note `effects` is present and useless: it
      // is the id/label list, exactly as perf-lab returns it. The first version
      // of these fixtures invented `effects[].gpuMsDelta` and the tests passed
      // by validating that fiction against itself, while the live sweep
      // delivered nothing.
      sweep: {
        effects: [
          { id: 'bloom', label: 'Bloom' },
          { id: 'vegetation', label: 'Vegetation' },
        ],
        summary: {
          perEffect: [
            { id: 'bloom', label: 'Bloom', costMs: 0.85 },
            { id: 'vegetation', label: 'Vegetation', costMs: 0.94 },
          ],
        },
      },
      megapixels: 3.56,
      enabledEffects: ['bloom', 'specular'],
    });
    const byId = Object.fromEntries(effects.map((e) => [e.id, e]));

    ok("bloom has both a zone sum and a sweep -> method 'both'", byId.bloom.method === 'both');
    ok('bloom sums its own zones', Math.abs(byId.bloom.zoneGpuMs - 0.8) < 1e-9);
    ok('bloom agrees with the sweep', byId.bloom.agreement === 'agree');
    ok('bloom converts to ms/Mpx', byId.bloom.measuredMsPerMp > 0);

    ok("specular is zoned but not swept -> method 'zone'", byId.specular.method === 'zone');
    ok('specular has no sweep number rather than a 0', byId.specular.sweepMarginalGpuMs === null);
    ok('specular agreement is null with only one method', byId.specular.agreement === null);

    // Vegetation: CPU sync is zoned, the DRAW is not. The zone sum understates,
    // so the sweep must win the costMs slot and the reason must be printed.
    ok('vegetation is declared partial', byId.vegetation.zoneCoverage === 'partial');
    ok('vegetation prefers the sweep for costMs where zoning is admittedly partial', byId.vegetation.costMs === 0.94);
    ok('vegetation says WHY it cannot be fully zoned', byId.vegetation.whyNotZoned.includes('geometry.world'));
    ok('vegetation records that its cost basis was the sweep', byId.vegetation.costBasis === 'sweep');

    ok('enabled flags come through', byId.bloom.enabled === true && byId.vegetation.enabled === false);
    ok('the zone id list is carried for drill-down', byId.bloom.zones.length === 2);

    // A CPU-only zone makes an effect "zoned" but gives no second GPU number,
    // so promising 'both' would promise an agreement check that cannot exist.
    ok("a cpu-only zone + a sweep is 'sweep', never 'both'", byId.vegetation.method === 'sweep');

    // Take the sweep away entirely: the CPU zone is still a real measurement,
    // just one with no GPU number to report — 'cpu-zone-only', never 'unmeasured'.
    // 2026-08-05: caught reporting this as "structurally blind to CPU cost" when
    // it was already sitting right here, just never surfaced to a reader.
    const [vegNoSweep] = attributeZonesToEffects({
      rows,
      manifests: [VEGETATION],
      effectZoning: EFFECT_ZONING,
      sweep: null,
      megapixels: 3.56,
    });
    ok("a CPU-zoned effect with no sweep at all is 'cpu-zone-only'", vegNoSweep.method === 'cpu-zone-only');
    ok('its real CPU cost is on zoneCpuMs, not lost', vegNoSweep.zoneCpuMs === 0.4);
    ok(
      'it still has no GPU number to fabricate',
      vegNoSweep.zoneGpuMs === null && vegNoSweep.sweepMarginalGpuMs === null
    );
  }

  // ======================================================================
  // The four confidence bugs found by LOOKING at a rendered report rather
  // than by reading the tests. Each one was a number stated with more
  // certainty than the measurement behind it earned.
  // ======================================================================
  {
    // (1) PARTIAL COVERAGE + NO SWEEP MUST BE NULL, NOT THE FRAGMENT.
    // Water's bake is zoned; its draw is not. Reporting the bake alone as
    // "water's cost" and then grading it 'within' its declared budget invents
    // confidence out of a gap we have already documented.
    const rows = buildZoneRows({
      zones: ZONES,
      frames: 612,
      zoneStats: [zs('light.waterBodyBake', { gpu: acc(41.2, 1, 41.2) })],
    });
    const [water] = attributeZonesToEffects({
      rows,
      manifests: [WATER],
      effectZoning: EFFECT_ZONING,
      sweep: null,
      megapixels: 3.56,
    });
    ok('partial coverage with no sweep yields costMs null, not the fragment', water.costMs === null);
    ok('...and no costBasis is claimed', water.costBasis === null);
    ok('...and no ms/Mpx is fabricated', water.measuredMsPerMp === null);
    ok("...and the declared verdict is 'unmeasured', never 'within'", water.declared.verdict === 'unmeasured');
    ok('...and the note says WHY it is not comparable', water.declared.note.includes('fragment'));
    ok('the zone number is still reported, just not promoted to a total', water.zones.length === 1);

    // (2) AN ALL-BAKE EFFECT HAS NO ms/Mpx. A bake amortised over the window is
    // not a per-megapixel shading cost; comparing them is a category error.
    const [sun] = attributeZonesToEffects({
      rows: buildZoneRows({
        zones: ZONES,
        frames: 612,
        zoneStats: [zs('light.sunShadowBake', { gpu: acc(14.4, 3, 5.4) })],
      }),
      manifests: [SUN_SHADOWS],
      effectZoning: EFFECT_ZONING,
      megapixels: 3.56,
    });
    ok('an all-bake effect does not get a steady zoneGpuMs', sun.zoneGpuMs === null);
    ok('an all-bake effect does not get a fabricated ms/Mpx', sun.measuredMsPerMp === null);
    ok('an all-bake effect is not graded against a declared per-pixel budget', sun.declared.verdict === 'unmeasured');
    ok('...and the note explains the category error', sun.declared.note.includes('BAKE'));
    ok('its sparse cost IS reported, as peak + rate', sun.sparse.peakMs === 5.4 && sun.sparse.occurrences === 3);
    ok(
      'the sparse note forbids reading it as a per-frame median',
      sun.sparse.note.includes('never a per-frame median')
    );

    // (3) STEADY AND SPARSE ARE NEVER ADDED.
    const mixed = attributeZonesToEffects({
      rows: buildZoneRows({
        zones: ZONES,
        frames: 100,
        zoneStats: [
          zs('surface.specularDraw', { gpu: acc(100, 100, 2) }),
          zs('light.sunShadowBake', { gpu: acc(50, 1, 50) }),
        ],
      }),
      manifests: [SPECULAR, SUN_SHADOWS],
      effectZoning: EFFECT_ZONING,
      megapixels: 1,
    });
    const spec = mixed.find((e) => e.id === 'specular');
    ok('a steady effect sums only its steady zones', spec.zoneGpuMs === 1);
    ok('a steady effect with no bakes has a null sparse block', spec.sparse === null);
  }

  // ---- (4) per-pass residual: opaque vs cheap must be distinguishable -------
  {
    const rows = annotatePassResiduals(
      buildZoneRows({
        zones: ZONES,
        frames: 100,
        zoneStats: [
          zs('pass.light.accumulate', { gpu: acc(50, 100, 2) }), //  0.5 OWN (un-bracketed)
          zs('light.drawPointLights', { gpu: acc(100, 100, 2) }), // 1.0 child
          zs('light.drawIllum', { gpu: acc(50, 100, 1) }), //        0.5 child
          zs('pass.geometry.world', { gpu: acc(142, 100, 3) }), //   1.42, no children at all
        ],
      })
    );
    const light = rows.find((r) => r.id === 'pass.light.accumulate');
    const geom = rows.find((r) => r.id === 'pass.geometry.world');

    ok('a pass knows how many sub-zones it has', light.childCount === 2);
    ok('a pass reports what its children explain', light.childGpuMs === 1.5);
    // EXCLUSIVE: the pass's own gpuMs IS the residual, not a subtraction.
    ok('a pass reports its own un-broken-down interior directly', light.ownGpuMs === 0.5);
    ok('the pass TOTAL is derived by adding children back on', light.totalGpuMs === 2);
    ok('...and the row says the GPU column is exclusive', light.gpuIsExclusive === true);
    ok('a well-explained pass gets no scolding note', light.breakdownNote === null);

    ok('a pass with no sub-zones says so', geom.childCount === 0);
    ok(
      '...and names it a gap in the taxonomy, not evidence of cheapness',
      geom.breakdownNote.includes('gap in the taxonomy')
    );

    const findings = deriveFindings({
      attribution: computeAttribution({ frameGpuMs: 4, rows }),
      rows,
      effects: [],
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
    });
    ok(
      'an expensive un-broken-down pass becomes a finding',
      findings.some((f) => f.id === 'pass-not-broken-down:pass.geometry.world')
    );

    // A pass whose children explain most of it must NOT be flagged.
    const quiet = annotatePassResiduals(
      buildZoneRows({
        zones: ZONES,
        frames: 100,
        zoneStats: [zs('pass.post.bloom', { gpu: acc(5, 100, 1) }), zs('bloom.downsample', { gpu: acc(95, 100, 2) })],
      })
    );
    ok('a well-explained pass produces no note', quiet.find((r) => r.id === 'pass.post.bloom').breakdownNote === null);

    // ...but a pass where most of the GPU time escapes its sub-zones DOES scold.
    const leaky = annotatePassResiduals(
      buildZoneRows({
        zones: ZONES,
        frames: 100,
        zoneStats: [zs('pass.post.bloom', { gpu: acc(90, 100, 2) }), zs('bloom.downsample', { gpu: acc(10, 100, 1) })],
      })
    );
    ok(
      'a pass whose sub-zones explain little says so',
      leaky.find((r) => r.id === 'pass.post.bloom').breakdownNote.includes('does not explain most of it')
    );
  }

  // ======================================================================
  // CONTRACT: the sweep's REAL output must flow into the effect rollup
  // ======================================================================
  {
    // This block drives `summarizeSweep` — the actual producer — instead of a
    // hand-written fixture, because a hand-written fixture is exactly how the
    // original bug survived: the report read `sweep.effects[].gpuMsDelta`, a
    // field that has never existed, and the tests asserted against the same
    // invention. Live, the sweep ran and delivered nothing, silently.
    const sweepEffects = [
      { id: 'bloom', label: 'Bloom' },
      { id: 'specular', label: 'Metal & shine' },
    ];
    // `raw` is keyed exactly as runSweep writes it: BASELINE / per-effect / ALL.
    const raw = {
      __baseline__: { gpuMs: 10, gpuSampleCount: 20, feltP50: 12 },
      bloom: { gpuMs: 11.3, gpuSampleCount: 20, feltP50: 13 },
      specular: { gpuMs: 13.2, gpuSampleCount: 20, feltP50: 15 },
      __all__: { gpuMs: 14.5, gpuSampleCount: 20, feltP50: 16 },
    };
    const summary = summarizeSweep(raw, sweepEffects);
    ok('summarizeSweep produces perEffect rows', Array.isArray(summary.perEffect) && summary.perEffect.length === 2);
    ok('...carrying costMs, the field the report must read', Number.isFinite(summary.perEffect[0].costMs));
    ok(
      '...and NOT a field called gpuMsDelta (the invented one)',
      summary.perEffect.every((e) => e.gpuMsDelta === undefined)
    );

    const effects = attributeZonesToEffects({
      rows: buildZoneRows({
        zones: ZONES,
        frames: 100,
        zoneStats: [zs('surface.specularDraw', { gpu: acc(320, 100, 4) })],
      }),
      manifests: [BLOOM, SPECULAR],
      effectZoning: EFFECT_ZONING,
      sweep: { effects: sweepEffects, summary },
      megapixels: 1,
    });
    const byId = Object.fromEntries(effects.map((e) => [e.id, e]));
    ok('the real sweep shape reaches the effect rollup', byId.bloom.sweepMarginalGpuMs === 1.3);
    ok('...for every effect it measured', byId.specular.sweepMarginalGpuMs === 3.2);
    ok('bloom, zoneless here, takes its cost from the sweep', byId.bloom.costBasis === 'sweep');
    ok('specular, zoned AND swept, reports method both', byId.specular.method === 'both');
  }

  // ---- a sweep that yields nothing must be a LOUD finding, not a null column
  {
    const effects = attributeZonesToEffects({
      rows: [],
      manifests: [BLOOM],
      effectZoning: EFFECT_ZONING,
      // The exact broken case: a sweep object with no usable per-effect costs.
      sweep: { effects: [{ id: 'bloom' }], summary: { perEffect: [] } },
      megapixels: 1,
    });
    const findings = deriveFindings({
      attribution: computeAttribution({ frameGpuMs: 5, rows: [] }),
      rows: [],
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      sweepRequested: true,
      sweepMeasuredCount: 0,
    });
    const f = findings.find((x) => x.id === 'sweep-produced-nothing');
    ok('a sweep that produced nothing is a HIGH finding', f !== undefined && f.severity === 'high');
    ok('...saying the run was wasted', f.text.includes('wasted'));
    ok('...and naming the effects that therefore stay unmeasured', f.text.includes('vegetation'));

    // And a healthy sweep must NOT trip it.
    const clean = deriveFindings({
      attribution: computeAttribution({ frameGpuMs: 5, rows: [] }),
      rows: [],
      effects: [],
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      sweepRequested: true,
      sweepMeasuredCount: 3,
    });
    ok('a working sweep raises no such finding', !clean.some((x) => x.id === 'sweep-produced-nothing'));
  }

  // ======================================================================
  // FRAME RATE — lowest, highest, average over the WHOLE window
  // ======================================================================
  {
    ok('no samples gives null, not a zero-fps block', summariseFrameRate([]) === null);
    ok('a non-array gives null', summariseFrameRate(null) === null);

    // THE AVERAGING TRAP, pinned. One 200ms frame and one 5ms frame is
    // 2 frames / 205ms = 9.8 fps FELT. Averaging the two instantaneous rates
    // (5fps and 200fps) gives 102 fps — an answer nobody experienced.
    const trap = summariseFrameRate([200, 5]);
    ok('avgFps is frames over elapsed time, not the mean of per-frame fps', trap.avgFps === 9.8);
    ok('...and says so, because this is quoted wrongly constantly', trap.avgFpsNote.includes('NOT the mean'));
    ok('worstFps comes from the worst gap', trap.worstFps === 5);
    ok('bestFps comes from the best gap', trap.bestFps === 200);

    // A realistic run: mostly 25ms (40fps) with a few bad frames.
    const gaps = [...Array(95).fill(25), 40, 45, 60, 90, 160];
    const s = summariseFrameRate(gaps);
    ok('the median is the steady state', s.medianFps === 40);
    ok('the worst frame is reported, not smoothed away', s.worstFps === 6.3);
    ok('the 1% low sits between median and worst', s.p1LowFps < s.medianFps && s.p1LowFps > s.worstFps);
    ok('the 5% low is milder than the 1% low', s.p5LowFps >= s.p1LowFps);
    ok('the sample count rides along', s.sampleCount === 100);
    ok('frame times are reported beside the rates', s.frameMs.worst === 160 && s.frameMs.median === 25);
    ok(
      'an explicit duration overrides the summed gaps',
      summariseFrameRate([10, 10], { durationMs: 1000 }).avgFps === 2
    );
  }

  // ---- hangs: banded, located in time, never just counted -----------------
  {
    ok('no samples gives null', findHangs([]) === null);

    const gaps = [...Array(50).fill(25), 60, 120, 300, ...Array(50).fill(25)];
    const h = findHangs(gaps, { medianMs: 25 });
    const band = (label) => h.bands.find((b) => b.label.includes(label));
    ok('a >50ms frame counts as a hitch', band('hitch').count === 3);
    ok('a >100ms frame counts as a stall', band('stall').count === 2);
    ok('a >250ms frame counts as a freeze', band('freeze').count === 1);
    ok('bands are CUMULATIVE — the 300ms frame is in all of them', band('freeze').count <= band('stall').count);
    ok('the stutter band is derived from the median, not a fixed number', band('stutter').minMs === 50);
    ok('the worst hang is first', h.worst[0].gapMs === 300);
    ok('...and carries WHEN it happened, so it can be reproduced', typeof h.worst[0].atSec === 'number');
    ok('...at a sensible time into the run', h.worst[0].atSec > 1 && h.worst[0].atSec < 3);
    ok('the total is counted', h.totalStalls === 3);
    ok('the note explains the cumulative banding', h.note.includes('cumulative'));

    // Truncation must be counted, never silent.
    const many = [...Array(200).fill(25), ...Array(40).fill(80)];
    const capped = findHangs(many, { keep: 5, medianMs: 25 });
    ok('the kept list is capped', capped.worst.length === 5);
    ok('...and what was dropped is COUNTED', capped.dropped === 35);
    ok('...with the true total preserved', capped.totalStalls === 40);

    // A clean run reports zero stalls without inventing any.
    const clean = findHangs(Array(100).fill(16.7), { medianMs: 16.7 });
    ok('a clean run has no stalls', clean.totalStalls === 0);
    ok('...and an empty worst list, not a fabricated one', clean.worst.length === 0);
  }

  // ======================================================================
  // THE SWEEP'S NOISE FLOOR — a negative cost is noise, not a measurement
  // ======================================================================
  {
    ok(
      'no negatives means no evidence about noise, so null',
      estimateSweepNoiseFloor([{ costMs: 1 }, { costMs: 2 }]) === null
    );
    ok(
      'the floor is the magnitude of the worst negative',
      estimateSweepNoiseFloor([{ costMs: 1 }, { costMs: -1.1 }, { costMs: -0.4 }]) === 1.1
    );
    ok('an empty sweep yields null', estimateSweepNoiseFloor([]) === null);
    ok('a non-array yields null', estimateSweepNoiseFloor(null) === null);
    ok(
      'nulls are ignored rather than counted as 0',
      estimateSweepNoiseFloor([{ costMs: null }, { costMs: -0.5 }]) === 0.5
    );
  }

  {
    // THE REAL 2026-07-27 SWEEP, verbatim. Every one of these was printed as a
    // legitimate cost in the first working full-sweep report, and several became
    // "comfortably under the declared budget" verdicts.
    const perEffect = [
      { id: 'specular', costMs: 3.9 },
      { id: 'fluid', costMs: 2.5 },
      { id: 'uiWindowShadow', costMs: 0.6 }, // DISABLED, and has no draw call at all
      { id: 'candleFlame', costMs: 0.1 },
      { id: 'bloom', costMs: -0.2 },
      { id: 'window', costMs: -0.2 },
      { id: 'sunShadows', costMs: -0.4 },
      { id: 'grade', costMs: -0.5 },
      { id: 'water', costMs: -0.8 },
      { id: 'vegetation', costMs: -0.9 },
      { id: 'doorGraphics', costMs: -1.1 },
    ];
    ok('the real sweep self-reports a 1.1ms noise floor', estimateSweepNoiseFloor(perEffect) === 1.1);

    const effects = attributeZonesToEffects({
      rows: buildZoneRows({
        zones: ZONES,
        frames: 600,
        zoneStats: [
          zs('surface.specularDraw', { gpu: acc(2000, 589, 4.98) }),
          zs('light.vegetationSync', { cpu: acc(9, 600, 0.2) }),
        ],
      }),
      manifests: [SPECULAR, VEGETATION, BLOOM, CANDLE_FLAME],
      effectZoning: EFFECT_ZONING,
      sweep: { summary: { perEffect } },
      megapixels: 7.32,
    });
    const byId = Object.fromEntries(effects.map((e) => [e.id, e]));

    ok('a negative sweep cost is REJECTED, not reported', byId.vegetation.sweepMarginalGpuMs === null);
    ok('...flagged as negative', byId.vegetation.sweepUnresolvable === 'negative');
    ok('...with the rejected reading kept for inspection', byId.vegetation.sweepRawMs === -0.9);
    ok('...and a note calling it impossible', byId.vegetation.sweepUnresolvableNote.includes('impossible'));

    ok('a NEGATIVE reading is rejected as impossible', byId.bloom.sweepUnresolvable === 'negative');
    // candleFlame measured +0.1 — positive, but far inside the ±1.1 band, so it
    // is the same noise wearing a luckier sign.
    ok(
      'a POSITIVE reading inside the noise band is rejected too',
      byId.candleFlame.sweepUnresolvable === 'below-noise-floor'
    );
    ok('...naming the band', byId.candleFlame.sweepUnresolvableNote.includes('1.1'));
    ok('...and keeping the rejected reading', byId.candleFlame.sweepRawMs === 0.1);

    ok('specular, far above the floor, SURVIVES', byId.specular.sweepMarginalGpuMs === 3.9);
    ok('...and is not flagged', byId.specular.sweepUnresolvable === null);
    ok('...and agrees with its zone measurement', byId.specular.agreement === 'agree');

    // The crucial one: a rejected sweep must never become a cost or a verdict.
    ok('vegetation gets NO fabricated cost from rejected noise', byId.vegetation.costMs === null);
    ok('...and no ms/Mpx', byId.vegetation.measuredMsPerMp === null);
    ok('...and NO "comfortably under budget" verdict', byId.vegetation.declared.verdict === 'unmeasured');
    ok(
      'no effect anywhere reports a negative cost',
      effects.every((e) => e.costMs === null || e.costMs >= 0)
    );
    ok(
      'no effect anywhere reports a negative ms/Mpx',
      effects.every((e) => e.measuredMsPerMp === null || e.measuredMsPerMp >= 0)
    );

    // And the findings must say why, loudly, rather than leaving empty columns.
    const findings = deriveFindings({
      attribution: computeAttribution({ frameGpuMs: 21.63, rows: [] }),
      rows: [],
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      sweepRequested: true,
      sweepMeasuredCount: effects.filter((e) => e.sweepMarginalGpuMs !== null).length,
      sweepNoiseFloorMs: 1.1,
      sweepRejectedCount: effects.filter((e) => e.sweepUnresolvable !== null).length,
    });
    const f = findings.find((x) => x.id === 'sweep-below-resolution');
    ok('the sweep resolution limit is a finding', f !== undefined);
    ok('...naming the floor', f.text.includes('1.1'));
    ok('...and telling the reader which column to trust', f.text.includes('Trust zoneGpuMs'));
    ok(
      'a rejected sweep raises no bogus method-disagreement',
      !findings.some((x) => x.id === 'method-disagreement:bloom')
    );
  }

  // ---- a bake that never fired must not read as "baked N times, cheaply" ----
  {
    const rows = buildZoneRows({
      zones: ZONES,
      frames: 600,
      // The live shape: maybeBake() CHECKED every frame, never baked, so there
      // is CPU time for the check and no GPU work at all.
      zoneStats: [zs('light.sunShadowBake', { cpu: acc(5.4, 600, 0.2) })],
    });
    const [sun] = attributeZonesToEffects({
      rows,
      manifests: [SUN_SHADOWS],
      effectZoning: EFFECT_ZONING,
      megapixels: 7.32,
    });
    ok('a check-only bake is flagged as not fired', sun.sparse.bakeFired === false);
    ok('...and says what it actually measured', sun.sparse.measures === 'check-only');
    ok('...and labels the occurrence count as CHECKS, not bakes', sun.sparse.occurrencesAre === 'checks');
    ok('...in words, at the top of the block', sun.sparse.note.includes('DID NOT FIRE'));
    ok('...telling the reader how to actually measure it', sun.sparse.note.includes('sun angle'));
    ok('...and the declared comparison says NOT MEASURED AT ALL', sun.declared.note.includes('NOT MEASURED AT ALL'));

    // A bake that DID fire keeps the original, correct wording.
    const fired = buildZoneRows({
      zones: ZONES,
      frames: 600,
      zoneStats: [zs('light.sunShadowBake', { gpu: acc(14.4, 3, 5.4), cpu: acc(3.4, 3, 1.4) })],
    });
    const [firedSun] = attributeZonesToEffects({
      rows: fired,
      manifests: [SUN_SHADOWS],
      effectZoning: EFFECT_ZONING,
      megapixels: 7.32,
    });
    ok('a real bake is flagged as fired', firedSun.sparse.bakeFired === true);
    ok('...and its occurrences are bakes', firedSun.sparse.occurrencesAre === 'bakes');
    ok('...with the peak preserved', firedSun.sparse.peakMs === 5.4);
  }

  // ---- a pass we cannot price must never print "null%" ---------------------
  {
    const rows = annotatePassResiduals(
      buildZoneRows({
        zones: ZONES,
        frames: 600,
        // A disabled pass: bracketed, but no GPU work whatsoever.
        zoneStats: [zs('pass.surface.particles', { cpu: acc(0.5, 600, 0.1) })],
      })
    );
    const findings = deriveFindings({
      attribution: computeAttribution({ frameGpuMs: 23, rows }),
      rows,
      effects: [],
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
    });
    ok(
      'an unpriceable pass raises NO breakdown finding at all',
      !findings.some((f) => f.id.startsWith('pass-not-broken-down:'))
    );
    ok(
      'nothing anywhere in the findings contains the string "null%"',
      findings.every((f) => !f.text.includes('null%'))
    );
  }

  // ======================================================================
  // Collapsing — summarised, never silently dropped
  // ======================================================================
  {
    const rows = buildZoneRows({
      zones: ZONES,
      frames: 100,
      zoneStats: [
        zs('light.drawPointLights', { gpu: acc(140, 100, 2.5) }), // big, kept
        zs('tick.camera', { cpu: acc(0.2, 100, 0.02) }), //          tiny + detail -> collapsed
        zs('light.ambient', { cpu: acc(0.3, 100, 0.02) }), //        tiny + detail -> collapsed
      ],
    });
    const { kept, collapsed } = collapseInsignificant(rows, { frameGpuMs: 6 });
    ok(
      'the expensive zone is kept',
      kept.some((r) => r.id === 'light.drawPointLights')
    );
    ok('tiny detail zones are collapsed', collapsed.count === 2);
    ok('every collapsed id is named so "where is my zone" has an answer', collapsed.ids.length === collapsed.count);
    ok('collapsed totals are reported', collapsed.cpuMsTotal !== null);
    ok('the collapsed note says how to expand it', collapsed.note.includes('full'));

    // A non-detail zone is never collapsed, however cheap.
    const nonDetail = buildZoneRows({
      zones: ZONES,
      frames: 100,
      zoneStats: [zs('light.pointLightUpdate', { cpu: acc(0.1, 100, 0.01) })],
    });
    ok(
      'a non-detail zone is kept even when tiny',
      collapseInsignificant(nonDetail, { frameGpuMs: 6 }).kept.length === 1
    );
  }

  // ======================================================================
  // Findings — ranked, and they fire on the things that matter
  // ======================================================================
  {
    const rows = buildZoneRows({
      zones: ZONES,
      frames: 100,
      zoneStats: [
        zs('light.drawPointLights', { gpu: acc(300, 100, 4), drawCalls: { sum: 300, count: 100 } }),
        zs('light.sunShadowBake', { gpu: acc(40, 2, 22) }),
      ],
    });
    const attribution = computeAttribution({ frameGpuMs: 6, rows });
    const effects = attributeZonesToEffects({
      rows,
      manifests: [BLOOM],
      effectZoning: EFFECT_ZONING,
      sweep: null,
      megapixels: 3.56,
    });
    const findings = deriveFindings({
      attribution,
      rows,
      effects,
      frame: { hitches: { count: 4, thresholdMs: 50 } },
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
    });

    const ids = findings.map((f) => f.id);
    ok('the dominant zone is named', ids.includes('dominant-zone'));
    ok(
      'a sparse zone peaking over budget is flagged',
      ids.some((i) => i.startsWith('sparse-spike:'))
    );
    ok('hitches are reported', ids.includes('hitches'));
    ok('findings are sorted with high severity first', findings[0].severity === 'high');
    ok(
      'every finding carries evidence',
      findings.every((f) => f.evidence && typeof f.evidence === 'object')
    );
    ok(
      'every finding has a severity we recognise',
      findings.every((f) => ['high', 'medium', 'low'].includes(f.severity))
    );

    // No GPU method at all must be the loudest thing in the report.
    const blind = deriveFindings({
      attribution: computeAttribution({ frameGpuMs: null, rows: [] }),
      rows: [],
      effects: [],
      frame: {},
      method: { gpu: 'frame-only', gpuReason: 'timestamp-query unavailable on this adapter' },
      budgetMs: 8.33,
    });
    ok('missing GPU attribution is a high-severity finding', blind[0].id === 'gpu-attribution-unavailable');
    ok('it explains that nulls are necessity, not measurement', blind[0].text.includes('by necessity'));

    // Pool overflow must be surfaced, since it silently truncates measurement.
    const overflowed = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query', timestampPoolOverflowed: true },
      budgetMs: 8.33,
    });
    ok(
      'timestamp pool overflow is surfaced',
      overflowed.some((f) => f.id === 'timestamp-pool-overflow')
    );
    ok(
      'without a gpuTimer, evidence stays exactly what it always was (no crash on the older shape)',
      overflowed.find((f) => f.id === 'timestamp-pool-overflow').evidence.maxPendingSize === undefined
    );

    // gpu-zone-timer.js's overflow diagnostics (2026-08-09), when present, ride
    // along on the SAME finding rather than creating a second one.
    const overflowedWithDiagnostics = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query', timestampPoolOverflowed: true },
      gpuTimer: { maxPendingSize: 1847, maxResolveSkipStreak: 22 },
      budgetMs: 8.33,
    });
    ok(
      'still exactly one pool-overflow finding, not a duplicate',
      overflowedWithDiagnostics.filter((f) => f.id === 'timestamp-pool-overflow').length === 1
    );
    const enriched = overflowedWithDiagnostics.find((f) => f.id === 'timestamp-pool-overflow');
    ok('its evidence carries the peak pending size', enriched.evidence.maxPendingSize === 1847);
    ok('...and the peak resolve-skip streak', enriched.evidence.maxResolveSkipStreak === 22);

    // PIPELINE GROWTH (2026-08-09) — a steady pan-only window recompiling
    // shader pipelines it should already have cached.
    const pipelineGrew = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      pipelineStats: { start: { programs: 12 }, end: { programs: 19 } },
    });
    const grewFinding = pipelineGrew.find((f) => f.id === 'pipeline-programs-grew');
    ok('growth during the window is surfaced', grewFinding !== undefined);
    ok('a small delta (< 10) stays medium, not high', grewFinding.severity === 'medium');
    ok('evidence carries both raw counts and the delta', grewFinding.evidence.delta === 7);

    const pipelineGrewALot = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      pipelineStats: { start: { programs: 12 }, end: { programs: 30 } },
    });
    ok(
      'a double-digit delta escalates to high',
      pipelineGrewALot.find((f) => f.id === 'pipeline-programs-grew').severity === 'high'
    );

    // Flat or shrinking must NOT trip it — programs only ever accumulate while
    // live (three's own info.memory.programs), so a drop would mean a
    // dispose/rebuild cycle, a different (and not yet a finding) shape.
    const pipelineFlat = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      pipelineStats: { start: { programs: 12 }, end: { programs: 12 } },
    });
    ok('no growth raises no finding', !pipelineFlat.some((f) => f.id === 'pipeline-programs-grew'));

    // A harness that never implemented readPipelineStats — the common case
    // today — must not crash or fabricate a finding from missing data.
    const pipelineAbsent = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      pipelineStats: null,
    });
    ok(
      'no pipelineStats at all raises no finding (absence, not a zero)',
      !pipelineAbsent.some((f) => f.id === 'pipeline-programs-grew')
    );

    // SHADER-REBUILD CHURN (2026-08-11) — the general-purpose version of the
    // check above: watches three's own node-graph cache directly, so it
    // catches a rebuild regardless of which subsystem caused it, unlike
    // depth-proxy-pool-health which can only see churn INSIDE that one pool.
    const churning = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      shaderRebuildStats: {
        installed: true,
        calls: 1397,
        hits: 632,
        misses: 765,
        labelsDropped: 0,
        labels: [
          { label: 'Mesh/NodeMaterial', misses: 765, materialChanged: 763, nodesChanged: 1, distinctCacheKeys: 512 },
        ],
      },
    });
    const churnFinding = churning.find((f) => f.id === 'shader-rebuild-churn');
    ok('a real repeat-rebuild is surfaced', churnFinding !== undefined);
    ok(
      '...at HIGH severity unconditionally — a repeat rebuild is never a cold start',
      churnFinding.severity === 'high'
    );
    ok('...naming the worst label', churnFinding.text.includes('Mesh/NodeMaterial'));
    ok(
      '...and identifying the cause as a NEW material object, with the pooling fix',
      churnFinding.text.includes('NEW material object') && churnFinding.text.includes('pool')
    );
    ok(
      '...warning that renderer.info.programs will NOT show this',
      churnFinding.text.includes('programs will NOT show')
    );
    ok(
      'evidence carries the raw counts',
      churnFinding.evidence.materialChanged === 763 && churnFinding.evidence.nodesChanged === 1
    );

    // The OTHER shape: same material, rebuilt nodes — pooling would not help,
    // and the finding's own fix text must say so, not repeat the pooling advice.
    const nodesChurning = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      shaderRebuildStats: {
        installed: true,
        calls: 10,
        hits: 0,
        misses: 3,
        labelsDropped: 0,
        labels: [
          { label: 'canopy/NodeMaterial', misses: 3, materialChanged: 0, nodesChanged: 2, distinctCacheKeys: 3 },
        ],
      },
    });
    const nodesFinding = nodesChurning.find((f) => f.id === 'shader-rebuild-churn');
    ok('the same-material-new-nodes shape is also caught', nodesFinding !== undefined);
    ok(
      '...and its fix text says pooling would NOT help, rather than repeating the pooling advice',
      nodesFinding.text.includes('pooling the material would change nothing')
    );

    // A cold-start-only window (every label's first-ever miss, never a
    // repeat) must NOT trip this — the probe's own classification already
    // excludes the first miss, but the finding must not re-derive it wrong.
    const coldOnly = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      shaderRebuildStats: {
        installed: true,
        calls: 40,
        hits: 0,
        misses: 40,
        labelsDropped: 0,
        labels: [
          { label: 'tile/NodeMaterial', misses: 40, materialChanged: 0, nodesChanged: 0, distinctCacheKeys: 40 },
        ],
      },
    });
    ok(
      'a probe that saw only first-ever misses (no repeats) raises no finding',
      !coldOnly.some((f) => f.id === 'shader-rebuild-churn')
    );

    // A probe that never armed (harness didn't implement the hook) must not
    // fabricate a finding from missing data.
    const churnAbsent = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      shaderRebuildStats: null,
    });
    ok(
      'no shaderRebuildStats at all raises no finding (absence, not a zero)',
      !churnAbsent.some((f) => f.id === 'shader-rebuild-churn')
    );

    // A probe that armed but found a fully healthy window (only cold-start
    // misses, or pure hits) must also stay quiet.
    const churnHealthy = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      shaderRebuildStats: { installed: true, calls: 100, hits: 100, misses: 0, labelsDropped: 0, labels: [] },
    });
    ok('a fully healthy window raises no finding', !churnHealthy.some((f) => f.id === 'shader-rebuild-churn'));

    // PIPELINE-REBUILD CHURN (2026-08-12) — one cache layer downstream of
    // shader-rebuild-churn above: a flat per-label miss count (no
    // materialChanged/nodesChanged split — a pipeline miss already names the
    // render object directly), so the finding applies the "first miss is a
    // cold start, not churn" bar by hand instead of relying on the probe.
    const pipelineChurning = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      pipelineRebuildStats: {
        installed: true,
        calls: 900,
        hits: 850,
        misses: 50,
        labelsDropped: 0,
        labels: [{ label: 'window/glass', misses: 6 }],
      },
    });
    const pipelineChurnFinding = pipelineChurning.find((f) => f.id === 'pipeline-rebuild-churn');
    ok('a real repeat pipeline compile is surfaced', pipelineChurnFinding !== undefined);
    ok(
      '...at HIGH severity unconditionally — a repeat compile is never a cold start',
      pipelineChurnFinding.severity === 'high'
    );
    ok('...naming the worst label', pipelineChurnFinding.text.includes('window/glass'));
    ok(
      '...counting repeats beyond the first (5, not 6)',
      pipelineChurnFinding.text.includes('5 time(s)') && pipelineChurnFinding.evidence.misses === 6
    );
    ok(
      '...distinguishing itself from shader-rebuild-churn explicitly',
      pipelineChurnFinding.text.includes('DIFFERENT cache from shader-rebuild-churn')
    );

    // A cold-start-only window (every label's first-ever miss, never a
    // repeat) must NOT trip this.
    const pipelineColdOnly = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      pipelineRebuildStats: {
        installed: true,
        calls: 40,
        hits: 0,
        misses: 40,
        labelsDropped: 0,
        labels: [{ label: 'tile/NodeMaterial', misses: 1 }],
      },
    });
    ok(
      'a label seen only once (a cold compile) raises no finding',
      !pipelineColdOnly.some((f) => f.id === 'pipeline-rebuild-churn')
    );

    // A probe that never armed (harness didn't implement the hook) must not
    // fabricate a finding from missing data.
    const pipelineChurnAbsent = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      pipelineRebuildStats: null,
    });
    ok(
      'no pipelineRebuildStats at all raises no finding (absence, not a zero)',
      !pipelineChurnAbsent.some((f) => f.id === 'pipeline-rebuild-churn')
    );

    // A probe that armed but found a fully healthy window must also stay quiet.
    const pipelineChurnHealthy = deriveFindings({
      attribution,
      rows,
      effects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      pipelineRebuildStats: { installed: true, calls: 100, hits: 100, misses: 0, labelsDropped: 0, labels: [] },
    });
    ok(
      'a fully healthy window raises no finding',
      !pipelineChurnHealthy.some((f) => f.id === 'pipeline-rebuild-churn')
    );

    // A declared cost the measurement contradicts.
    const overEffects = attributeZonesToEffects({
      rows: buildZoneRows({ zones: ZONES, frames: 100, zoneStats: [zs('bloom.bright', { gpu: acc(1000, 100, 12) })] }),
      manifests: [BLOOM],
      effectZoning: EFFECT_ZONING,
      megapixels: 1,
    });
    const overFindings = deriveFindings({
      attribution,
      rows,
      effects: overEffects,
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
    });
    ok(
      'an understated declared cost class is a finding',
      overFindings.some((f) => f.id === 'declared-cost-understated:bloom')
    );
  }

  // ======================================================================
  // End to end — including the all-empty case, which must not invent numbers
  // ======================================================================
  {
    const empty = buildPerfReport({ generatedAt: '2026-07-27T00:00:00.000Z', zones: ZONES, manifests: [] });
    ok('an empty report still identifies itself', empty.report === 'perf-profile');
    ok('an empty report has a stable formatVersion', empty.formatVersion === 1);
    ok('empty: frame GPU is null, not 0', empty.attribution.frameGpuMs === null);
    ok('empty: coverage is null, not 0', empty.attribution.coverage === null);
    ok("empty: verdict is 'unmeasured'", empty.attribution.verdict === 'unmeasured');
    ok('empty: gap percentiles are null, not 0', empty.frame.gapMs.p50 === null);
    ok('empty: the shape series is null, not 60 zeros', empty.frame.shape === null);
    ok('empty: the histogram is null, not 8 zeroed bands', empty.frame.histogram === null);
    ok('empty: megapixels is null without a resolution', empty.window.megapixels === null);
    ok('empty: there are no zones rather than fabricated ones', empty.zones.length === 0);
    ok(
      'empty: an interpretation is still present',
      typeof empty.interpretation === 'string' && empty.interpretation.length > 100
    );
    ok(
      'empty: findings still explain the blindness',
      empty.findings.some((f) => f.id === 'gpu-attribution-unavailable')
    );

    const full = buildPerfReport({
      generatedAt: '2026-07-27T00:00:00.000Z',
      msaVersion: '0.1.4',
      window: {
        frames: 612,
        durationMs: 5104,
        settleFramesDiscarded: 30,
        resolution: { w: 2560, h: 1392 },
        sceneName: 'Church',
        floorIndex: 0,
      },
      method: { gpu: 'timestamp-query', cpuClockResolutionMs: 0.1 },
      zones: ZONES,
      effectZoning: EFFECT_ZONING,
      zoneStats: [
        zs('pass.light.accumulate', { gpu: acc(1600, 612, 5.9) }),
        zs('light.drawPointLights', { gpu: acc(870, 612, 3.8), drawCalls: { sum: 1836, count: 612 } }),
        zs('pass.post.bloom', { gpu: acc(720, 612, 2.1) }),
        zs('bloom.bright', { gpu: acc(120, 612, 0.5) }),
        zs('light.sunShadowBake', { gpu: acc(14.4, 3, 5.4) }),
        // Vegetation's sync is CPU-zoned; the sweep below covers only bloom, so
        // vegetation has a real cost with no GPU number at all — 'cpu-zone-only'.
        zs('light.vegetationSync', { cpu: acc(244.8, 612, 0.9) }),
      ],
      frame: {
        gapSamples: Array.from({ length: 612 }, (_, i) => (i === 141 ? 168.4 : 8.4)),
        gpuMs: { p50: 6.12, p95: 9.84, sampleCount: 588 },
        hitches: [{ atMs: 1204.5, gapMs: 168.4 }],
        hitchThresholdMs: 50,
      },
      manifests: [BLOOM, SPECULAR, VEGETATION],
      sweep: { effects: [{ id: 'bloom' }], summary: { perEffect: [{ id: 'bloom', costMs: 1.31 }] } },
      budgetMs: 8.33,
    });

    ok('megapixels are derived from the resolution', full.window.megapixels === 3.56);
    ok('the frame partition is pass-level and does not exceed 1', full.attribution.coverage <= 1);
    ok('coverage is a real fraction', full.attribution.coverage > 0);
    ok('the shape series is present and bounded', full.frame.shape.worstGapMs.length === SHAPE_BUCKETS);
    ok('the spike survives condensation', full.frame.shape.worstGapMs.includes(168.4));
    ok('the histogram is populated', full.frame.histogram.length > 0);
    ok(
      'hitches are kept with a dropped count',
      full.frame.hitches.droppedFromReport === 0 && full.frame.hitches.count === 1
    );
    // A viewer that never told us how many its own ring discarded must read as
    // UNKNOWN. `?? 0` here is what hid a 430-hitch loss for three captures.
    ok('an unreported ring-drop count is null, not zero', full.frame.hitches.droppedByRing === null);
    ok('effects are rolled up', full.effects.length === 3);
    ok(
      'zones are sorted by GPU cost, heaviest first',
      full.zones[0].gpuMs.amortisedMsPerFrame >= full.zones[1].gpuMs.amortisedMsPerFrame
    );
    ok(
      'the method block explains why zones have no percentiles',
      full.method.zoneStatsNote.includes('zero-allocation')
    );
    ok('sweepIncluded reflects reality', full.method.sweepIncluded === true);
    ok('the interpretation names the verdict it saw', full.interpretation.includes(full.attribution.verdict));

    const vegFull = full.effects.find((e) => e.id === 'vegetation');
    ok('a real combined report rolls up a CPU-only effect as such', vegFull.method === 'cpu-zone-only');
    ok('...with its cost intact', vegFull.zoneCpuMs === 0.4);
    ok(
      'a CPU-only cost gets its own finding rather than sitting silent in effects[]',
      full.findings.some((f) => f.id === 'cpu-only-cost:vegetation')
    );
    ok('the interpretation guide tells a reader where to look for it', full.interpretation.includes('cpu-zone-only'));

    // Size discipline: the whole point of the sampling rules above.
    const bytes = JSON.stringify(full, null, 2).length;
    ok(`the default report is compact (${(bytes / 1024).toFixed(1)}KB < 40KB)`, bytes < 40 * 1024);

    // verbosity:'full' expands rather than collapsing, and keeps every hitch.
    const verbose = buildPerfReport({
      generatedAt: '2026-07-27T00:00:00.000Z',
      zones: ZONES,
      manifests: [],
      window: { frames: 100 },
      zoneStats: [zs('tick.camera', { cpu: acc(0.2, 100, 0.02) })],
      frame: { hitches: Array.from({ length: HITCHES_KEPT + 5 }, (_, i) => ({ atMs: i, gapMs: 60 + i })) },
      verbosity: 'full',
    });
    ok('verbosity full collapses nothing', verbose.zonesCollapsed.count === 0);
    ok('verbosity full keeps every hitch', verbose.frame.hitches.droppedFromReport === 0);

    const capped = buildPerfReport({
      generatedAt: '2026-07-27T00:00:00.000Z',
      zones: ZONES,
      manifests: [],
      frame: { hitches: Array.from({ length: HITCHES_KEPT + 5 }, (_, i) => ({ atMs: i, gapMs: 60 + i })) },
    });
    ok('the default report caps hitches', capped.frame.hitches.kept === HITCHES_KEPT);
    ok('capped hitches are COUNTED as dropped, never silently lost', capped.frame.hitches.droppedFromReport === 5);
    ok('the hitches kept are the WORST ones', capped.frame.hitches.items[0].gapMs === 60 + HITCHES_KEPT + 4);

    // TWO DIFFERENT LOSSES, NEVER SUMMED (2026-08-12). The viewer's ring
    // discarding the oldest hitches is a REAL loss of data; the report showing
    // only the worst 20 of what it received is a display cap. Adding them made
    // a run that lost 430 hitches to the ring report `dropped: 180`, all of it
    // the harmless one — which is how the ring loss stayed invisible.
    const bothLosses = buildPerfReport({
      generatedAt: '2026-07-27T00:00:00.000Z',
      zones: ZONES,
      manifests: [],
      frame: {
        hitches: Array.from({ length: HITCHES_KEPT + 5 }, (_, i) => ({ atMs: i, gapMs: 60 + i })),
        hitchesDropped: 430,
      },
    });
    ok('a real ring loss is reported separately', bothLosses.frame.hitches.droppedByRing === 430);
    ok('...from the display cap', bothLosses.frame.hitches.droppedFromReport === 5);
    ok(
      '...and count is labelled as RECEIVED, not as total',
      bothLosses.frame.hitches.countIsReceivedNotTotal.includes('reached this report')
    );
  }

  // ======================================================================
  // WHAT WAS IN FLIGHT WHEN IT FROZE (2026-08-12)
  // ======================================================================
  // The 2026-08-11 residency audit closed §5 unable to say whether the 250-667ms
  // freezes overlapped an in-flight residency pass, and said it would need a
  // Chrome trace. Both possible answers are findings — a zero overlap RULES OUT
  // the hypothesis, which is worth as much as confirming it.
  {
    const base = {
      attribution: { frameGpuMs: 70 },
      rows: [],
      effects: [],
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      profilerAnomalies: {},
      gpuTimer: {},
    };
    const overlap = deriveFindings({
      ...base,
      frame: { inFlightDuringHitches: { thresholdMs: 50, frames: 200, zones: { 'residency.itemLoad': 180 } } },
    });
    const hit = overlap.find((x) => x.id === 'hitches-overlap-zone');
    ok('a zone open during most hitches is surfaced', hit !== null && hit !== undefined);
    ok('...at high severity past half', hit.severity === 'high');
    ok('...with the share computed', hit.evidence.zonesInFlight[0].share === 90);
    ok('...and it explicitly refuses to call overlap causation', hit.text.includes('OVERLAP IS NOT CAUSE'));
    ok('...telling the reader what to compare it against', hit.text.includes('occurrence rate'));

    const clean = deriveFindings({
      ...base,
      frame: { inFlightDuringHitches: { thresholdMs: 50, frames: 200, zones: {} } },
    });
    const ruled = clean.find((x) => x.id === 'hitches-no-zone-in-flight');
    ok('hitches with NOTHING open is itself a finding', ruled !== null && ruled !== undefined);
    ok('...framed as a result, not a missing measurement', ruled.text.includes('RULES OUT'));
    ok('...and it names where to look next', ruled.text.includes('GC'));

    // No hitches at all is not a finding in either direction.
    const quiet = deriveFindings({
      ...base,
      frame: { inFlightDuringHitches: { thresholdMs: 50, frames: 0, zones: {} } },
    });
    ok(
      'a window with no hitches produces neither finding',
      !quiet.some((x) => x.id.startsWith('hitches-no-zone') || x.id.startsWith('hitches-overlap'))
    );
  }

  // ======================================================================
  // Declared-vs-measured is stated as absence, not as a zero, for cpu zones
  // ======================================================================
  {
    const rows = buildZoneRows({
      zones: ZONES,
      frames: 100,
      zoneStats: [zs('light.vegetationSync', { cpu: acc(50, 100, 1.2) })],
    });
    ok('a cpu-only zone has null GPU time', rows[0].gpuMs === null);
    ok('...and says that is BY DECLARATION, not a failed measurement', rows[0].gpuAbsentByDeclaration === true);

    const gpuZone = buildZoneRows({ zones: ZONES, frames: 100, zoneStats: [zs('light.drawIllum', {})] });
    ok('a gpu zone with no samples also has null GPU time', gpuZone[0].gpuMs === null);
    ok('...but does NOT claim the absence is by declaration', gpuZone[0].gpuAbsentByDeclaration === false);
  }

  // ======================================================================
  // drawCalls/triangles suppressed for 'cpu' zones (2026-08-11,
  // Residency-Streaming-Audit §2/§6.1) — a 'cpu' zone's bracket can span a
  // real await and sample an UNRELATED frame's draws (frame-profiler.js
  // samples renderer.info unconditionally, with no check of zone kind); a
  // nonzero reading there was never a real cost of that zone. gpuAbsentByDeclaration
  // already promises "no draw calls at all" for these zones — this pins that
  // the promise is actually enforced, not just documented.
  // ======================================================================
  {
    // A real 'cpu'-kind zone (light.vegetationSync), fed CONTAMINATED raw
    // drawCalls/triangles data — exactly the shape a zone whose bracket spans
    // an unrelated rendered frame would produce.
    const rows = buildZoneRows({
      zones: ZONES,
      frames: 100,
      zoneStats: [
        zs('light.vegetationSync', {
          cpu: acc(50, 100, 1.2),
          drawCalls: { sum: 36500, count: 100 },
          triangles: { sum: 42844800, count: 100 },
        }),
      ],
    });
    ok('a cpu-kind zone reports null drawCalls, even with contaminated raw data', rows[0].drawCalls === null);
    ok('...and null triangles, same reason', rows[0].triangles === null);

    // A real 'gpu'-kind zone with genuine draws must NOT be affected.
    const gpuRows = buildZoneRows({
      zones: ZONES,
      frames: 100,
      zoneStats: [zs('light.drawPointLights', { gpu: acc(300, 100, 4), drawCalls: { sum: 300, count: 100 } })],
    });
    ok('a gpu-kind zone keeps its real drawCalls, unaffected', gpuRows[0].drawCalls === 3);

    // A 'both'-kind zone (real draws AND real CPU wall time) must also pass through.
    const bothRows = buildZoneRows({
      zones: ZONES,
      frames: 100,
      zoneStats: [zs('geometry.earlyZPrepass', { gpu: acc(200, 100, 3), drawCalls: { sum: 900, count: 100 } })],
    });
    ok("a 'both'-kind zone keeps its real drawCalls too", bothRows[0].drawCalls === 9);
  }

  // ======================================================================
  // summarizeTierComparison — THE optimisation-priority tool (rewritten
  // 2026-07-29 the same day, from the author's own first real run: ~300KB,
  // and the effect that actually moved was invisible in it)
  // ======================================================================
  {
    // A fixture shaped like the exact shape that caught the original gap:
    // an effect (candleFlame) whose OWN zone barely moves, sitting beside an
    // UNOWNED shared zone (light.drawPointLights) that grows hard with tier —
    // and a second registered effect (bloom) that owns ITS OWN zone, so
    // listing it AGAIN as a raw zone row would double-count it.
    const reportFor = ({ worldDraw, pointLights, candleZone, bloomZone, avgFps }) => ({
      window: { frames: 3000 },
      attribution: { coverage: 0.95, verdict: 'good' },
      frame: {
        gpuMs: { p50: worldDraw + pointLights, p95: worldDraw + pointLights + 2, sampleCount: 600 },
        fps: { avgFps, p1LowFps: avgFps - 5 },
        hangs: { totalStalls: 1 },
      },
      effects: [
        { id: 'candleFlame', label: 'Candle flames', zoneGpuMs: candleZone, costMs: candleZone },
        { id: 'bloom', label: 'Bloom', zoneGpuMs: bloomZone, costMs: bloomZone },
        // NEVER measured in either tier — must still appear, not vanish.
        { id: 'grade', label: 'Colour Grade', zoneGpuMs: null, costMs: null },
      ],
      zones: [
        {
          id: 'geometry.worldDraw',
          label: 'World scene draw',
          ownerEffectId: null,
          isPass: false,
          gpuMs: { amortisedMsPerFrame: worldDraw },
        },
        {
          id: 'light.drawPointLights',
          label: 'Point light draw',
          ownerEffectId: null,
          isPass: false,
          gpuMs: { amortisedMsPerFrame: pointLights },
        },
        // Owned by bloom already (rolled into its effects[] row above) — must
        // NOT also appear as a standalone zone row, or bloom's cost doubles.
        {
          id: 'bloom.composite',
          label: 'Bloom composite',
          ownerEffectId: 'bloom',
          isPass: false,
          gpuMs: { amortisedMsPerFrame: bloomZone },
        },
        // A PASS container — the sum of children already in this list, so it
        // must not ALSO be listed (that would double geometry.worldDraw too).
        {
          id: 'pass.geometry.world',
          label: 'geometry.world',
          ownerEffectId: null,
          isPass: true,
          gpuMs: { amortisedMsPerFrame: worldDraw },
        },
        // CPU-only — no GPU cost to rank by.
        {
          id: 'light.pointLightUpdate',
          label: 'Point light pool update',
          ownerEffectId: null,
          isPass: false,
          gpuMs: null,
        },
      ],
    });

    const cmp = summarizeTierComparison([
      {
        profile: 'low',
        report: reportFor({ worldDraw: 10, pointLights: 1.5, candleZone: 0.007, bloomZone: 0.57, avgFps: 60 }),
      },
      {
        profile: 'extreme',
        report: reportFor({ worldDraw: 10.9, pointLights: 2.75, candleZone: 0.021, bloomZone: 0.57, avgFps: 50 }),
      },
    ]);

    // --- frame + health, unchanged shape from v1 ----------------------------
    ok('one frame row per tier, keyed by profile', 'low' in cmp.frame && 'extreme' in cmp.frame);
    ok('frame GPU is read straight from frame.gpuMs.p50', cmp.frame.low.gpuMsP50 === 11.5);
    ok('hitch count comes from hangs.totalStalls, not a label search over bands[]', cmp.frame.low.hitchCount === 1);
    ok(
      'perTierHealth carries the trust check WITHOUT the full report',
      cmp.perTierHealth.low.coverage === 0.95 &&
        cmp.perTierHealth.low.verdict === 'good' &&
        cmp.perTierHealth.low.frames === 3000
    );

    // --- THE FIX: a shared, unowned zone shows up on its own ----------------
    const byId = (id) => cmp.ranked.find((r) => r.id === id);
    ok('an unowned zone with real GPU cost gets its own ranked row', !!byId('light.drawPointLights'));
    ok('that row is tagged as a zone, not an effect', byId('light.drawPointLights').kind === 'zone');
    ok(
      "the unowned zone's cost is visibly different across tiers — this is the candle finding, generalised",
      byId('light.drawPointLights').byProfile.low === 1.5 && byId('light.drawPointLights').byProfile.extreme === 2.75
    );

    // --- NOT double-counted: an owned zone is absent as its own row ---------
    ok('a zone already rolled into an effect row is NOT also listed standalone', !byId('bloom.composite'));
    ok('a pass container is NOT listed (it would double its own children)', !byId('pass.geometry.world'));
    ok('a CPU-only zone with no GPU number is not a cost row', !byId('light.pointLightUpdate'));

    // --- ranking: sorted by peak cost, effects and zones mixed in one list --
    ok(
      'the list is sorted by peak (max-across-tiers) cost, descending',
      cmp.ranked.every((r, i) => i === 0 || (cmp.ranked[i - 1].maxGpuMs ?? -1) >= (r.maxGpuMs ?? -1))
    );
    ok(
      'geometry.worldDraw outranks everything — it is the biggest number in the fixture',
      cmp.ranked[0].id === 'geometry.worldDraw'
    );

    // --- honesty: an unmeasured effect still gets a row, sorted to the bottom, never a fabricated 0
    const gradeRow = byId('grade');
    ok('an effect never measured in any tier still appears', !!gradeRow);
    ok('...marked NOT measured, not silently reading as cheap', gradeRow.measured === false);
    ok('...with a null peak, never a fabricated 0', gradeRow.maxGpuMs === null);
    ok('unmeasured rows sort to the very bottom', cmp.ranked[cmp.ranked.length - 1].id === 'grade');

    // --- malformed / empty input: total, never throws -----------------------
    ok('an empty list produces an empty table, not a throw', summarizeTierComparison([]).ranked.length === 0);
    ok(
      'a malformed (non-array) input produces an empty table, not a throw',
      summarizeTierComparison(null).ranked.length === 0
    );
    ok(
      'an entry missing its profile string is skipped, not crashed on',
      Object.keys(
        summarizeTierComparison([
          { report: reportFor({ worldDraw: 1, pointLights: 1, candleZone: 1, bloomZone: 1, avgFps: 60 }) },
        ]).frame
      ).length === 0
    );
    ok(
      'an entry missing its report is skipped, not crashed on',
      Object.keys(summarizeTierComparison([{ profile: 'low' }]).frame).length === 0
    );
  }

  // ======================================================================
  // THE DIAGNOSTIC FINDINGS (2026-08-12) — questions the report now answers
  // itself instead of leaving to whoever reads it
  // ======================================================================
  //
  // Every number in this block is REAL, from the 2026-08-12 Mansion capture
  // (floor 1, N→S, 3840×1906@1.5x, 675 frames). Fixtures invented to make an
  // assertion pass prove the assertion, not the tool — and this project already
  // has a name for that (feedback_synthetic_fixture_invariant_is_not_authored_art).
  {
    // --- classifyBottleneck: the median and the tail can disagree ----------
    const b = classifyBottleneck({ gapMs: { p50: 75, p95: 108.4 }, gpuMs: { p50: 70.78, p95: 76.35 } });
    ok("the headline verdict is the MEDIAN's — the felt frame rate", b.verdict === 'gpu-bound');
    ok('...94.4% of the median frame is inside a timestamped pass', b.median.gpuFraction === 0.944);
    ok('...but the p95 tail is only 70.4% explained', b.tail.gpuFraction === 0.704);
    ok('...so the tail lands on a DIFFERENT verdict', b.tail.verdict === 'mixed');
    ok('...and the disagreement is stated, not averaged away', b.tailDiffers === true);
    ok('the tail names its own unexplained ms', b.tail.unexplainedMs === 32.05);
    ok(
      'the note refuses to call the remainder "CPU time"',
      b.note.includes('NOT proven to be CPU time') && b.note.includes('presentation')
    );

    // A null is an absence: no samples must not read as a balanced frame.
    const none = classifyBottleneck({ gapMs: null, gpuMs: null });
    ok('no samples yields verdict "unmeasured", never a fabricated balance', none.verdict === 'unmeasured');
    ok('...with null halves, not zeroed ones', none.median === null && none.tail === null);
    ok(
      'a zero gap cannot divide by zero into a verdict',
      classifyBottleneck({ gapMs: { p50: 0 }, gpuMs: { p50: 5 } }).verdict === 'unmeasured'
    );

    // --- the findings, driven off the real zone shapes ---------------------
    const row = (id, over = {}) => ({
      id,
      isPass: false,
      sparse: false,
      gpuAbsentByDeclaration: false,
      drawCalls: null,
      triangles: null,
      gpuMs: null,
      cpuMs: null,
      ...over,
    });
    const findingIds = (f) => f.map((x) => x.id);
    const find = (f, id) => f.find((x) => x.id === id) ?? null;

    const realRows = [
      row('geometry.earlyZPrepass', { drawCalls: 9.1, triangles: 73116.1, gpuMs: { amortisedMsPerFrame: 18.129 } }),
      row('geometry.depthDraw', { drawCalls: 9.1, triangles: 73116.1, gpuMs: { amortisedMsPerFrame: 18.196 } }),
      row('geometry.depthRenderCall', {
        gpuAbsentByDeclaration: true,
        site: 'runSceneDepthPass',
        gpuMs: { amortisedMsPerFrame: 18.196 },
      }),
      row('residency.itemLoad', {
        sparse: true,
        gpuAbsentByDeclaration: true,
        cpuMs: { meanMs: 9.406, maxMs: 25.4, totalMs: 6189, occurrences: 658, amortisedMsPerFrame: 9.169 },
      }),
    ];
    const f = deriveFindings({
      attribution: { frameGpuMs: 70.78, verdict: 'good', coverage: 0.984 },
      rows: realRows,
      effects: [],
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      bottleneck: b,
      profilerAnomalies: {},
      gpuTimer: {},
      pipelineStats: {
        start: { programs: 87, uniformBuffers: 5607 },
        end: { programs: 87, uniformBuffers: 17539 },
      },
    });

    // A 'cpu' zone carrying GPU time is a contradiction, and must be loud. This
    // is the guard that stays behind the gpu-zone-timer fix — the next zone
    // nested that way will be written by someone who never read it.
    const contradiction = find(f, 'zone-kind-contradiction:geometry.depthRenderCall');
    ok('a cpu-declared zone carrying GPU time is flagged', contradiction !== null);
    ok('...at high severity — it invalidates how two rows read', contradiction.severity === 'high');
    ok(
      '...and a genuinely cpu-only zone is NOT flagged',
      !findingIds(f).includes('zone-kind-contradiction:residency.itemLoad')
    );

    // The bottleneck outranks dominant-zone: "worldDraw is 33% of frame GPU" is
    // only actionable once you know frame GPU is most of the frame.
    const bf = find(f, 'bottleneck');
    ok('the bottleneck verdict is a finding, not just a block', bf !== null);
    ok('...escalated to high when the tail disagrees with the median', bf.severity === 'high');
    ok(
      '...it appears ABOVE dominant-zone',
      findingIds(f).indexOf('bottleneck') < findingIds(f).indexOf('dominant-zone')
    );

    // Two zones with the same draw signature are submitting the same meshes.
    const dup = find(f, 'duplicate-geometry:geometry.earlyZPrepass+geometry.depthDraw');
    ok('identical draw signatures across two zones are flagged', dup !== null);
    ok('...with both costs summed — 36ms of the 70.78ms frame', dup.evidence.combinedGpuMs === 36.325);
    ok('...at high severity, being over a quarter of frame GPU', dup.severity === 'high');
    ok('...and it refuses to declare which of the two readings it is', dup.text.includes('cannot tell which'));

    // THE ONE THAT CHANGES THE DIAGNOSIS. itemLoadDims/itemLoadMasks only open
    // on ensureItemLoaded's NEW-item path, so their absence measures "zero new
    // items", which means the 2026-08-11 audit's parallelise-the-awaits fix
    // cannot be what this window's 6.19s is waiting on.
    const res = find(f, 'residency-cost-is-not-io');
    ok('residency cost with no I/O sub-zones present is flagged', res !== null);
    ok('...at high severity — it redirects an already-planned fix', res.severity === 'high');
    ok(
      '...it names the absence as a measurement, not a gap',
      res.text.includes('MEASURES something rather than missing it')
    );
    ok('...and says the concurrency fix would buy nothing here', res.text.includes('would change nothing here'));
    ok('...evidence records that neither I/O zone was present', res.evidence.ioZonesPresent.length === 0);

    // The mirror case: when the I/O path DID run, report how much it explains
    // rather than firing the alarm.
    const withIo = deriveFindings({
      attribution: { frameGpuMs: 70.78 },
      rows: [
        ...realRows,
        row('residency.itemLoadDims', {
          sparse: true,
          gpuAbsentByDeclaration: true,
          cpuMs: { totalMs: 4000, occurrences: 8 },
        }),
        row('residency.itemLoadMasks', {
          sparse: true,
          gpuAbsentByDeclaration: true,
          cpuMs: { totalMs: 1800, occurrences: 8 },
        }),
      ],
      effects: [],
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      profilerAnomalies: {},
      gpuTimer: {},
    });
    ok(
      'when the I/O zones DID fire, the alarm does not fire',
      !findingIds(withIo).includes('residency-cost-is-not-io')
    );
    const share = find(withIo, 'residency-io-share');
    ok('...a share finding reports how much of the parent is real I/O', share !== null);
    ok('...93.7% of 6189ms accounted for by I/O', share.evidence.ioFraction === 0.937);
    ok('...so it stays at low severity and confirms the audit', share.severity === 'low');

    // uniformBuffers: P-008's "open lead", flagged rather than diagnosed.
    const ub = find(f, 'uniform-buffers-grew');
    ok('a >=2x uniformBuffers growth is surfaced at last', ub !== null);
    ok('...as a ratio, which is the only meaningful form', ub.evidence.ratio === 3.13);
    ok('...explicitly NOT calling it a leak', !ub.text.includes('leak') && ub.text.includes('NOT decided here'));
    ok('...and it names the experiment that would settle it', ub.text.includes('camera parked'));

    // ====================================================================
    // A STEADY ZONE WITH A CATASTROPHIC OUTLIER (2026-08-12) — steady-spike
    // ====================================================================
    // Real numbers from the 2026-08-12 08:22 capture: pass.light.accumulate
    // and light.pointLightUpdate BOTH looked perfectly healthy on their mean
    // alone (4.8ms, 0.76ms) while spiking 6.8x/30x — and no existing finding
    // (dominant-zone, bottleneck, sparse-spike) could see either, because the
    // first two only read means and the third only ever looks at sparse
    // (bake/event) zones.
    {
      const spikeRow = (id, over) => ({ id, isPass: false, sparse: false, gpuMs: null, cpuMs: null, ...over });
      const steadyRows = [
        // The pass ITSELF — a pass row's cpuMs is an ordinary inclusive
        // measurement (unlike its gpuMs, which is a residual — see the
        // finding's own header) and must NOT be skipped just for being a pass.
        {
          id: 'pass.light.accumulate',
          isPass: true,
          sparse: false,
          gpuMs: null,
          cpuMs: { meanMs: 4.802, maxMs: 32.7 },
        },
        spikeRow('light.pointLightUpdate', { cpuMs: { meanMs: 0.755, maxMs: 22.7 } }),
        spikeRow('light.drawPointLights', { cpuMs: { meanMs: 1.728, maxMs: 9.1 } }),
        // Just under the 5x ratio floor (4.81x) — must NOT fire. This is the
        // real fourth point-light zone from the same capture, deliberately
        // left just outside the threshold rather than invented round numbers,
        // so the boundary is pinned against a real reading, not a convenient one.
        spikeRow('light.drawColoration', { cpuMs: { meanMs: 1.207, maxMs: 5.8 } }),
        // A GPU-side spike, to prove the GPU column is checked independently
        // of CPU, not just carried along for zones that already spiked on CPU.
        spikeRow('geometry.worldDraw', { gpuMs: { meanMs: 2, maxMs: 20 }, cpuMs: { meanMs: 0.455, maxMs: 1.1 } }),
        // Healthy zone: real cost, real max, but nowhere near 5x — must NOT fire.
        spikeRow('bloom.composite', { gpuMs: { meanMs: 0.272, maxMs: 1.18 } }),
        // Below the absolute floor even though the RATIO is enormous (100x) —
        // a ratio alone must never be enough; the spike has to matter in ms too.
        spikeRow('tick.tokenSync', { cpuMs: { meanMs: 0.001, maxMs: 0.1 } }),
      ];
      const sf = deriveFindings({
        attribution: { frameGpuMs: 24.9 },
        rows: steadyRows,
        effects: [],
        frame: {},
        method: { gpu: 'timestamp-query' },
        budgetMs: 8.33,
        profilerAnomalies: {},
        gpuTimer: {},
      });
      const sfIds = sf.map((x) => x.id);

      ok(
        'the pass row itself fires — it is NOT skipped for being a pass',
        sfIds.includes('steady-spike:pass.light.accumulate')
      );
      ok('the 30x CPU spike fires', sfIds.includes('steady-spike:light.pointLightUpdate'));
      ok('the 5.3x CPU spike (just over the floor) fires', sfIds.includes('steady-spike:light.drawPointLights'));
      ok(
        'the 4.81x CPU spike (just under the floor) does NOT fire',
        !sfIds.includes('steady-spike:light.drawColoration')
      );
      ok('a GPU-column spike fires independently of CPU', sfIds.includes('steady-spike:geometry.worldDraw'));
      ok(
        'a healthy zone with real but unremarkable variance does not fire',
        !sfIds.includes('steady-spike:bloom.composite')
      );
      ok('a huge RATIO under the absolute ms floor does not fire', !sfIds.includes('steady-spike:tick.tokenSync'));

      const pu = sf.find((x) => x.id === 'steady-spike:light.pointLightUpdate');
      ok('30x ratio escalates to high severity', pu.severity === 'high');
      ok(
        '...the text states both the mean and the peak plainly',
        pu.text.includes('0.755ms') && pu.text.includes('22.7ms')
      );
      ok('...and names the ratio', pu.text.includes('30.1x'));
      ok('...evidence carries the raw spike data for further digging', pu.evidence.spikes[0].ratio === 30.1);

      const worldDraw = sf.find((x) => x.id === 'steady-spike:geometry.worldDraw');
      ok('the GPU spike is escalated to high (10x ratio ≥ 15 is false, so medium)', worldDraw.severity === 'medium');
      ok('...and labelled GPU, not CPU', worldDraw.text.includes('GPU'));

      const plu = sf.find((x) => x.id === 'steady-spike:light.pointLightUpdate');
      ok(
        '...cross-references the shader-rebuild finding rather than claiming a cause',
        plu.text.includes('hides a spike this size completely') && !plu.text.toLowerCase().includes('caused by')
      );
    }

    // ====================================================================
    // FRONT-LOADED BURST vs STEADY TAX (2026-08-12) — classifyTemporalShape
    // ====================================================================
    // Real numbers: a 53,584ms window, a 10,000ms early bucket (~18.7%
    // expected share for a uniform zone) — matches the 2026-08-12 capture.
    {
      const front = classifyTemporalShape({ totalMs: 6189, earlyMs: 6189, earlyWindowMs: 10000, durationMs: 53584 });
      ok('all cost inside the early bucket reads as front-loaded', front.verdict === 'front-loaded');
      ok('...expected share for a uniform zone over this window is ~18.7%', front.expectedEarlyFraction === 0.187);
      ok('...actual share is the full 100%', front.actualEarlyFraction === 1);
      ok('...the ratio is reported, not just the verdict', front.ratio === 5.36);
      ok('...lateMs is the true remainder, not re-derived elsewhere', front.lateMs === 0);

      // A zone whose early share MATCHES what uniform coverage predicts must
      // NOT be flagged — the comparison is against expected, not against zero.
      const steady = classifyTemporalShape({ totalMs: 6189, earlyMs: 1157, earlyWindowMs: 10000, durationMs: 53584 });
      ok('a share matching the expected fraction reads as steady', steady.verdict === 'steady');
      ok('...the ratio is exactly 1', steady.ratio === 1);

      // Getting WORSE over time is the opposite finding, not a null result.
      const back = classifyTemporalShape({ totalMs: 4000, earlyMs: 50, earlyWindowMs: 10000, durationMs: 53584 });
      ok('cost concentrated LATE reads as back-loaded, not steady', back.verdict === 'back-loaded');
      ok('...ratio well under 1', back.ratio < 1);

      // Below the noise floor: too small to say anything, not a fabricated verdict.
      const tiny = classifyTemporalShape({ totalMs: 20, earlyMs: 20, earlyWindowMs: 10000, durationMs: 53584 });
      ok('a near-zero total is unmeasured, not classified either way', tiny.verdict === 'unmeasured');

      // A window no longer than the early bucket cannot distinguish anything —
      // every sample IS early by construction, and the tool says so.
      const short = classifyTemporalShape({ totalMs: 500, earlyMs: 500, earlyWindowMs: 10000, durationMs: 4000 });
      ok('a window shorter than the early bucket is not-applicable', short.verdict === 'not-applicable');
      ok('...not silently treated as maximally front-loaded', short.verdict !== 'front-loaded');

      // Missing inputs (an older report, a fixture that never wired this
      // through) must default to inert, never throw and never fabricate.
      const blind = classifyTemporalShape({ totalMs: 500, earlyMs: 500 });
      ok('missing durationMs/earlyWindowMs is not-applicable, not a crash', blind.verdict === 'not-applicable');
    }

    // The finding itself, through deriveFindings — same real numbers.
    {
      const temporalRows = [
        {
          id: 'residency.itemLoad',
          isPass: false,
          cpuMs: { totalMs: 6189 },
          cpuEarlyMs: { totalMs: 6189 },
        },
        {
          // A steady zone in the SAME window must not get a finding.
          id: 'light.pointLightUpdate',
          isPass: false,
          cpuMs: { totalMs: 542 },
          cpuEarlyMs: { totalMs: 101 }, // ~18.6% — matches the ~18.7% expected
        },
      ];
      const tf = deriveFindings({
        attribution: { frameGpuMs: 70.78 },
        rows: temporalRows,
        effects: [],
        frame: {},
        method: { gpu: 'timestamp-query' },
        budgetMs: 8.33,
        earlyWindowMs: 10000,
        durationMs: 53584,
        profilerAnomalies: {},
        gpuTimer: {},
      });
      const shape = tf.find((x) => x.id === 'temporal-shape:residency.itemLoad');
      ok('the front-loaded zone gets its own finding', shape !== null && shape !== undefined);
      ok(
        '...naming the percentage AND the expected percentage',
        shape.text.includes('100%') && shape.text.includes('18.7%')
      );
      ok('...framed as a burst, not a per-frame tax', shape.text.includes('FRONT-LOADED'));
      ok('...telling the reader to stop trusting the blended mean', shape.text.includes('blended mean'));
      ok(
        '...evidence carries the raw numbers for further digging',
        tf.find((x) => x.id === 'temporal-shape:residency.itemLoad').evidence.earlyMs === 6189
      );
      ok(
        'the steady zone in the SAME window produces no finding',
        !tf.some((x) => x.id === 'temporal-shape:light.pointLightUpdate')
      );

      // Omitting earlyWindowMs/durationMs entirely (every fixture predating
      // this feature, and any caller of an older shape) must add ZERO new
      // findings — not crash, not fabricate a verdict from nothing.
      const noTemporal = deriveFindings({
        attribution: { frameGpuMs: 70.78 },
        rows: temporalRows,
        effects: [],
        frame: {},
        method: { gpu: 'timestamp-query' },
        budgetMs: 8.33,
        profilerAnomalies: {},
        gpuTimer: {},
      });
      ok(
        'omitting the temporal inputs produces no temporal-shape findings at all',
        !noTemporal.some((x) => x.id.startsWith('temporal-shape:'))
      );
    }

    // Effects with no route to a number at all — a standing gap, not a run gap.
    const stranded = deriveFindings({
      attribution: { frameGpuMs: 70.78 },
      rows: [],
      effects: [
        {
          id: 'water',
          enabled: true,
          zoneCoverage: 'partial',
          costMs: null,
          whyNotZoned: 'draws inside geometry.world',
        },
        {
          id: 'grade',
          enabled: true,
          zoneCoverage: 'none',
          costMs: null,
          whyNotZoned: 'folded into the present shader',
        },
        { id: 'bloom', enabled: true, zoneCoverage: 'full', costMs: 0.7 },
        { id: 'apertureGobo', enabled: false, zoneCoverage: 'partial', costMs: null },
      ],
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      profilerAnomalies: {},
      gpuTimer: {},
    });
    const unpriceable = find(stranded, 'effects-unpriceable');
    ok('effects with no route to a cost figure are named', unpriceable !== null);
    ok('...only the two that are enabled AND uncosted', unpriceable.evidence.effects.length === 2);
    ok('...a fully-zoned effect is not among them', !unpriceable.text.includes('bloom'));
    ok('...nor is a DISABLED one — it has no cost to miss', !unpriceable.text.includes('apertureGobo'));
    ok('...and it says re-running will not help', unpriceable.text.includes('re-running will not fix it'));
  }

  // ======================================================================
  // WINDOW-SURFACE SCENE COMPOSITION (2026-08-12) — window-surface-composition
  // ======================================================================
  // Chases the live, still-open finding: light.drawWindowLight reports ~4 GPU
  // draw calls per render() call where "one mesh, one quad" predicts 1.
  {
    const base = {
      attribution: { frameGpuMs: 24.9 },
      rows: [],
      effects: [],
      frame: {},
      method: { gpu: 'timestamp-query' },
      budgetMs: 8.33,
      profilerAnomalies: {},
      gpuTimer: {},
    };

    // The real anomaly shape: a VISIBLE floor with more than one scene child.
    const anomalyFindings = deriveFindings({
      ...base,
      windowDiagnostics: [
        { floorIndex: 0, visible: true, sceneChildCount: 2, sceneChildren: [{ type: 'Mesh' }, { type: 'Mesh' }] },
        { floorIndex: 1, visible: true, sceneChildCount: 1, sceneChildren: [{ type: 'Mesh' }] },
      ],
    });
    const anomaly = anomalyFindings.find((f) => f.id === 'window-surface-composition:0');
    ok('a visible floor with 2 scene children is flagged', anomaly !== undefined);
    ok('...names the exact count', anomaly.text.includes('contains 2 children'));
    ok('...names WHAT the extra members are', anomaly.text.includes('["Mesh","Mesh"]'));
    ok('...evidence carries the raw children for further digging', anomaly.evidence.sceneChildCount === 2);
    ok(
      'the healthy floor in the SAME window does not also fire',
      !anomalyFindings.some((f) => f.id === 'window-surface-composition:1')
    );

    // Zero children on a visible floor is a DIFFERENT, sharper contradiction
    // (hasContent()/visible say there is something to draw; the scene
    // disagrees) and gets its own sentence, not the generic "extra members" one.
    const zeroFindings = deriveFindings({
      ...base,
      windowDiagnostics: [{ floorIndex: 3, visible: true, sceneChildCount: 0, sceneChildren: [] }],
    });
    const zero = zeroFindings.find((f) => f.id === 'window-surface-composition:3');
    ok('zero children on a visible floor is its own, sharper finding', zero !== undefined);
    ok('...calling it a contradiction, not just "extra members"', zero.text.includes('contradiction'));

    // Healthy: every floor at exactly 1 child — no finding at all.
    const healthy = deriveFindings({
      ...base,
      windowDiagnostics: [
        { floorIndex: 0, visible: true, sceneChildCount: 1, sceneChildren: [{ type: 'Mesh' }] },
        { floorIndex: 1, visible: true, sceneChildCount: 1, sceneChildren: [{ type: 'Mesh' }] },
      ],
    });
    ok(
      'every floor at the expected count produces no findings at all',
      !healthy.some((f) => f.id.startsWith('window-surface-composition'))
    );

    // An INVISIBLE floor's composition is moot — must not fire even with a
    // wild count, since its draw cost is not part of this session's numbers.
    const invisible = deriveFindings({
      ...base,
      windowDiagnostics: [{ floorIndex: 2, visible: false, sceneChildCount: 5, sceneChildren: [] }],
    });
    ok(
      'an invisible floor is never flagged, regardless of its composition',
      !invisible.some((f) => f.id.startsWith('window-surface-composition'))
    );

    // Absence handling: null (no harness support) and [] (harness supports it,
    // nothing has synced yet) must both be safe no-ops, never a throw.
    const nullResult = deriveFindings({ ...base, windowDiagnostics: null });
    ok(
      'windowDiagnostics: null (no harness support) produces no findings, not a crash',
      !nullResult.some((f) => f.id.startsWith('window-surface-composition'))
    );
    const emptyResult = deriveFindings({ ...base, windowDiagnostics: [] });
    ok(
      'windowDiagnostics: [] (nothing synced yet) also produces no findings',
      !emptyResult.some((f) => f.id.startsWith('window-surface-composition'))
    );
    ok(
      'omitting windowDiagnostics entirely defaults safely',
      !deriveFindings(base).some((f) => f.id.startsWith('window-surface-composition'))
    );
  }
}
