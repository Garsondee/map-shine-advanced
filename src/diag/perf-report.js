/**
 * perf-report.js — THE REPORT BRAIN. Pure functions, no clock, no DOM, no GPU.
 *
 * Takes raw accumulators from `frame-profiler.js`, the zone taxonomy, the effect
 * manifests and (optionally) a `perf-lab` sweep, and produces the one object a
 * human reads to decide where to optimise. Everything interesting about this
 * tool's honesty lives here, which is why all of it is Node-tested.
 *
 * ============================================================================
 * THE FIVE RULES THIS FILE EXISTS TO ENFORCE
 * ============================================================================
 *
 * 1. NEVER 0 FOR "NOT MEASURED". Every statistic is `null` when there is no
 *    sample behind it, and every statistic carries the count that produced it.
 *    A zero is a measurement; a null is an absence. Conflating them is the
 *    named bug class `feedback_instruments_must_not_lie`.
 *
 * 2. PRINT THE RESIDUAL. `frameGpuMs − Σ attributed` is reported, not hidden,
 *    along with the coverage fraction and a verdict that DOWNGRADES ITSELF when
 *    coverage is poor. A breakdown that cannot account for a third of the frame
 *    must not look as confident as one that accounts for 95% of it.
 *
 * 3. SPARSE WORK IS NOT A PER-FRAME COST. A bake that ran 3 times in 612 frames
 *    has a median of 0 over all frames, which is a lie in both directions: it
 *    hides a 5ms spike AND implies a per-frame cost that does not exist. Sparse
 *    zones report occurrence rate + peak + amortised, and are excluded from
 *    per-frame medians entirely.
 *
 * 4. A CLOCK CANNOT RESOLVE WHAT IT CANNOT RESOLVE. Foundry sets no COOP/COEP,
 *    so the page is not cross-origin-isolated and `performance.now()` is clamped
 *    by every major browser. Quantisation averages out over N samples but not
 *    within one, so the standard error of the mean under uniform quantisation of
 *    step `r` over `n` samples is `r / sqrt(12n)` — below that, this file reports
 *    the zone as PRESENT but refuses to give it a number.
 *
 * 5. SAMPLE, DO NOT DUMP. Frame times ship as percentiles + a fixed fps
 *    histogram + a ~60-number shape series + every hitch. The author's ask was
 *    "a concise sampling of frame times without trying to export too much" —
 *    a per-frame array would be neither concise nor more informative.
 *
 * @module diag/perf-report
 */
import { HISTOGRAM_BUCKETS } from './flight-recorder.js';
import { medianOf, percentileOf } from './gpu-probe.js';
import { DEFAULT_PASS_BUDGET_MS, PASS_ZONE_PREFIX, isSparseCadence } from './perf-zones.js';

/** Coverage at or above this and the per-zone breakdown is trustworthy. */
export const COVERAGE_GOOD = 0.85;
/** Below this the breakdown is not worth reading as a breakdown at all. */
export const COVERAGE_UNRELIABLE = 0.6;
/** Default shape-series resolution: 60 numbers reads as a shape, not a dump. */
export const SHAPE_BUCKETS = 60;
/** A zone under BOTH of these is collapsed out of the default report. */
export const COLLAPSE_SHARE_PCT = 1.0;
export const COLLAPSE_CPU_MS = 0.05;
/** Measured above declared × this is a finding, not noise. */
export const DECLARED_OVER_FACTOR = 1.25;
/** Zone vs sweep disagreement beyond this fraction is worth flagging. */
export const AGREEMENT_TOLERANCE = 0.25;
/** Hitches kept in the default report; the rest are counted, never silently lost. */
export const HITCHES_KEPT = 20;

const round = (v, dp) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const ms = (v) => round(v, 3);
const pct = (v) => round(v, 1);

/**
 * The floor below which a mean is indistinguishable from clock quantisation.
 * Uniform quantisation of step `r` has variance `r²/12`; the standard error of a
 * mean over `n` independent samples is therefore `r / sqrt(12n)`.
 * @returns {number|null} null when the resolution is unknown — an unknown floor
 *   must not silently become a floor of 0.
 */
export function clockNoiseFloorMs(clockResolutionMs, count) {
  if (!Number.isFinite(clockResolutionMs) || clockResolutionMs <= 0) return null;
  if (!Number.isFinite(count) || count <= 0) return null;
  return clockResolutionMs / Math.sqrt(12 * count);
}

/**
 * Condense a gap series into a fixed number of "worst in this time bucket"
 * numbers — the SHAPE of the window (did it degrade? was there a spike at t=23s?)
 * at a fixed, tiny cost, instead of a per-frame dump.
 *
 * Worst-per-bucket, not mean-per-bucket, deliberately: a mean smooths away the
 * one 168ms frame that is the entire reason anyone opened the report.
 */
export function condenseFrameHistory(gapSamples, { buckets = SHAPE_BUCKETS, durationMs = null } = {}) {
  if (!Array.isArray(gapSamples) || gapSamples.length === 0) return null;
  const n = Math.min(buckets, gapSamples.length);
  const per = gapSamples.length / n;
  const worst = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const lo = Math.floor(i * per);
    const hi = i === n - 1 ? gapSamples.length : Math.floor((i + 1) * per);
    let w = -Infinity;
    for (let k = lo; k < hi; k++) if (gapSamples[k] > w) w = gapSamples[k];
    worst[i] = w === -Infinity ? null : ms(w);
  }
  return {
    note: `Worst frame gap in each of ${n} equal buckets across the window — the SHAPE, not a dump.`,
    buckets: n,
    framesPerBucket: round(per, 1),
    bucketMs: durationMs === null ? null : ms(durationMs / n),
    worstGapMs: worst,
  };
}

/**
 * Bin a gap series into the flight recorder's own fps bands. Imported, never
 * redeclared — see HISTOGRAM_BUCKETS' export note.
 */
export function buildHistogram(gapSamples) {
  if (!Array.isArray(gapSamples) || gapSamples.length === 0) return null;
  const counts = HISTOGRAM_BUCKETS.map(([, label]) => ({ label, frames: 0 }));
  for (const gap of gapSamples) {
    for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
      if (gap < HISTOGRAM_BUCKETS[i][0]) {
        counts[i].frames += 1;
        break;
      }
    }
  }
  const total = gapSamples.length;
  return counts.filter((b) => b.frames > 0).map((b) => ({ ...b, percent: pct((b.frames / total) * 100) }));
}

/**
 * THE HEADLINE FRAME-RATE BLOCK: worst, best, average — over the whole window.
 *
 * Author's directive, 2026-07-28: *"focus on the lowest frame rates, the highest
 * and the averages rather than obsessing about any one moment in the scan."*
 *
 * Two deliberate choices:
 *
 *   **`avgFps` is frames ÷ total time, NOT the mean of per-frame fps.** Those are
 *   different numbers and only the first is the frame rate you actually
 *   experienced. Averaging instantaneous fps over-weights fast frames — a run of
 *   one 200ms frame and one 5ms frame is 9.8 fps felt, but 102 fps if you average
 *   the two instantaneous rates. The harmonic-vs-arithmetic distinction is the
 *   entire reason "average fps" is so often quoted wrongly.
 *
 *   **`worstFps` comes from the WORST GAP**, and `p1LowFps`/`p5LowFps` from the
 *   1st/5th percentile of gaps — the game-benchmarking convention, because a
 *   single catastrophic frame should be visible but should not define the run.
 */
export function summariseFrameRate(gapSamples, { durationMs = null } = {}) {
  const n = Array.isArray(gapSamples) ? gapSamples.length : 0;
  if (n === 0) return null;
  const sorted = [...gapSamples].sort((a, b) => a - b);
  const total = durationMs ?? gapSamples.reduce((a, b) => a + b, 0);
  const fps = (ms) => (Number.isFinite(ms) && ms > 0 ? round(1000 / ms, 1) : null);
  // Nearest-rank on the SORTED-ASCENDING gaps: a big gap = a low fps, so the
  // "1% low" fps is the 99th percentile gap.
  const at = (p) => sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
  return {
    avgFps: total > 0 ? round((n * 1000) / total, 1) : null,
    avgFpsNote: 'frames ÷ elapsed time — the felt rate. NOT the mean of per-frame fps, which over-weights fast frames.',
    bestFps: fps(sorted[0]),
    worstFps: fps(sorted[n - 1]),
    p1LowFps: fps(at(0.99)),
    p5LowFps: fps(at(0.95)),
    medianFps: fps(at(0.5)),
    frameMs: {
      best: ms(sorted[0]),
      median: ms(at(0.5)),
      p95: ms(at(0.95)),
      p99: ms(at(0.99)),
      worst: ms(sorted[n - 1]),
    },
    sampleCount: n,
  };
}

/**
 * Every stall in the window, at three severities, with WHEN it happened.
 *
 * A "hang" is not one threshold. A 50ms frame is a visible stutter; a 250ms one
 * is the app appearing to freeze. Reporting only one number either drowns the
 * report in stutters or hides the freezes, so this reports bands and keeps the
 * worst few with their position in the run — "at 42s into the sweep" is what
 * makes a hang reproducible.
 */
export function findHangs(gapSamples, { keep = HITCHES_KEPT, medianMs = null } = {}) {
  const n = Array.isArray(gapSamples) ? gapSamples.length : 0;
  if (n === 0) return null;
  const bands = [
    { label: 'stutter (>2x median)', minMs: medianMs !== null ? medianMs * 2 : 33, count: 0 },
    { label: 'hitch (>50ms)', minMs: 50, count: 0 },
    { label: 'stall (>100ms)', minMs: 100, count: 0 },
    { label: 'freeze (>250ms)', minMs: 250, count: 0 },
  ];
  const worst = [];
  let elapsed = 0;
  for (let i = 0; i < n; i++) {
    const g = gapSamples[i];
    elapsed += g;
    for (const b of bands) if (g > b.minMs) b.count++;
    // Only consider genuine stalls for the worst-list, or it fills with jitter.
    if (g > bands[1].minMs) worst.push({ frame: i, atSec: round(elapsed / 1000, 2), gapMs: ms(g) });
  }
  worst.sort((a, b) => b.gapMs - a.gapMs);
  return {
    note: 'Bands are cumulative — a 300ms frame counts in all four. `worst` is sorted by severity and carries WHEN it happened, so a hang can be reproduced rather than just counted.',
    bands: bands.map((b) => ({ ...b, minMs: ms(b.minMs) })),
    totalStalls: worst.length,
    kept: Math.min(keep, worst.length),
    dropped: Math.max(0, worst.length - keep),
    worst: worst.slice(0, keep),
  };
}

/** Percentile block for a raw sample array. All-null (never all-zero) when empty. */
export function summariseSamples(samples) {
  const n = Array.isArray(samples) ? samples.length : 0;
  if (n === 0) return { p50: null, p90: null, p95: null, p99: null, max: null, sampleCount: 0 };
  return {
    p50: percentileOf(samples, 0.5),
    p90: percentileOf(samples, 0.9),
    p95: percentileOf(samples, 0.95),
    p99: percentileOf(samples, 0.99),
    max: ms(Math.max(...samples)),
    sampleCount: n,
  };
}

/**
 * One accumulator -> one reported stat block, or null when nothing ran.
 *
 * `meanMs` is per OCCURRENCE; `amortisedMsPerFrame` is per FRAME. For a steady
 * zone they are the same number. For a bake they differ by two orders of
 * magnitude, and reporting only one of them is how a 40ms bake either looks like
 * a catastrophe or vanishes entirely, depending which one you picked.
 */
export function statFrom(acc, frames) {
  if (!acc || !Number.isFinite(acc.count) || acc.count <= 0) return null;
  return {
    meanMs: ms(acc.sumMs / acc.count),
    maxMs: ms(acc.maxMs),
    amortisedMsPerFrame: Number.isFinite(frames) && frames > 0 ? ms(acc.sumMs / frames) : null,
    totalMs: ms(acc.sumMs),
    occurrences: acc.count,
  };
}

/**
 * Turn raw accumulators into reportable rows, joined to the taxonomy.
 *
 * Pass-level rows (`pass.<id>`) are synthesised by the profiler, not declared,
 * so they arrive here with no ZoneDecl; they are recognised by prefix.
 */
export function buildZoneRows({ zoneStats = [], zones = [], frames = 0, clockResolutionMs = null } = {}) {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const rows = [];
  for (const stat of zoneStats) {
    const isPass = stat.id.startsWith(PASS_ZONE_PREFIX);
    const decl = byId.get(stat.id) ?? null;
    const passId = isPass ? stat.id.slice(PASS_ZONE_PREFIX.length) : (decl?.pass ?? null);
    const cadence = decl?.cadence ?? (isPass ? 'steady' : 'conditional');
    const cpu = statFrom(stat.cpu, frames);
    const gpu = statFrom(stat.gpu, frames);
    const floor = clockNoiseFloorMs(clockResolutionMs, stat.cpu?.count ?? 0);
    rows.push({
      id: stat.id,
      label: decl?.label ?? (isPass ? passId : stat.id),
      kind: decl?.kind ?? 'gpu',
      stage: decl?.stage ?? null,
      cadence,
      sparse: isSparseCadence(cadence),
      isPass,
      parent: isPass ? null : passId === null ? null : `${PASS_ZONE_PREFIX}${passId}`,
      ownerEffectId: decl?.ownerEffectId ?? null,
      detail: decl?.detail ?? false,
      site: decl?.site ?? null,
      cpuMs: cpu,
      gpuMs: gpu,
      // A 'cpu' zone has no GPU work BY DECLARATION. That is a different fact
      // from "we failed to measure its GPU time", and the report says which.
      gpuAbsentByDeclaration: (decl?.kind ?? 'gpu') === 'cpu',
      occurrenceRate: frames > 0 ? round(stat.cpu?.count || stat.gpu?.count || 0, 0) / frames : null,
      belowClockResolution: cpu !== null && floor !== null && cpu.meanMs !== null && cpu.meanMs < floor,
      clockNoiseFloorMs: floor === null ? null : ms(floor),
      drawCalls: avgOf(stat.drawCalls),
      triangles: avgOf(stat.triangles),
      unbalanced: stat.unbalanced ?? 0,
    });
  }
  return rows;
}

function avgOf(acc) {
  if (!acc || !Number.isFinite(acc.count) || acc.count <= 0) return null;
  return round(acc.sum / acc.count, 1);
}

/**
 * Split the frame's GPU time into attributed and residual.
 *
 * ⚠️ GPU AND CPU HAVE OPPOSITE NESTING SEMANTICS, and getting this wrong is the
 * difference between a coverage figure and a fiction. Corrected 2026-07-27 after
 * the first live run showed every pass row with `gpu: —` beside children that
 * had real numbers:
 *
 *   CPU is INCLUSIVE. A bracket wraps its children in wall time, so
 *   `pass.light.accumulate`'s CPU covers `light.drawPointLights`'s too. Summing
 *   pass + child would double-count.
 *
 *   GPU is EXCLUSIVE. A timestamped render pass is attributed to the INNERMOST
 *   open zone (gpu-zone-timer.js), so every uid lands in exactly one row and a
 *   pass row only ever holds the GPU work that was NOT inside a sub-zone — its
 *   own un-bracketed interior. Summing every row is therefore correct, and
 *   summing only pass rows (as this function first did) would have discarded
 *   nearly all of it and reported a coverage near zero.
 *
 * So: sum EVERY non-event row's GPU. Event-cadence zones stay out because they
 * do not belong to any frame.
 */
export function computeAttribution({ frameGpuMs = null, rows = [] } = {}) {
  const inFrame = rows.filter((r) => r.cadence !== 'event');
  let attributed = 0;
  let any = false;
  for (const r of inFrame) {
    const v = r.gpuMs?.amortisedMsPerFrame;
    if (Number.isFinite(v)) {
      attributed += v;
      any = true;
    }
  }
  if (!any || !Number.isFinite(frameGpuMs) || frameGpuMs <= 0) {
    return {
      frameGpuMs: frameGpuMs === null ? null : ms(frameGpuMs),
      attributedGpuMs: any ? ms(attributed) : null,
      residualGpuMs: null,
      coverage: null,
      verdict: 'unmeasured',
      note:
        'No GPU attribution available for this window. This is an ABSENCE, not a zero — check method.gpu ' +
        'to see whether timestamp queries were available at all.',
    };
  }
  const coverage = attributed / frameGpuMs;
  const verdict = coverage >= COVERAGE_GOOD ? 'good' : coverage >= COVERAGE_UNRELIABLE ? 'indicative' : 'unreliable';
  return {
    frameGpuMs: ms(frameGpuMs),
    attributedGpuMs: ms(attributed),
    residualGpuMs: ms(frameGpuMs - attributed),
    coverage: round(coverage, 3),
    verdict,
    note: attributionNote(verdict, coverage),
  };
}

function attributionNote(verdict, coverage) {
  const unattributed = pct((1 - coverage) * 100);
  if (verdict === 'good') {
    return `${unattributed}% of frame GPU time is unattributed (pass setup, mipmap generation, presentation). The per-zone breakdown below is trustworthy.`;
  }
  if (verdict === 'indicative') {
    return `${unattributed}% of frame GPU time is unattributed. Treat the per-zone breakdown as INDICATIVE ONLY and lean on the effects[] sweep column, which measures marginal cost independently of zone timing.`;
  }
  return `${unattributed}% of frame GPU time is unattributed. The per-zone breakdown is NOT trustworthy as a partition of the frame — read it as "these zones cost at least this much", nothing more. Check method.gpu and any timestamp-pool overflow finding first.`;
}

/**
 * Compare a measured ms/Mpx against the manifest's declared cost.
 *
 * We do not know which tier was live during the window, so this compares against
 * the declared RANGE across tiers rather than guessing one and presenting the
 * guess as a fact. With a single-tier manifest the range collapses to a point.
 */
export function compareToManifest(measuredMsPerMp, manifest) {
  const tiers = Array.isArray(manifest?.tiers) ? manifest.tiers : [];
  const ests = tiers.map((t) => t?.cost?.estMsPerMp).filter((v) => Number.isFinite(v));
  if (ests.length === 0) {
    return { declaredMinMsPerMp: null, declaredMaxMsPerMp: null, classes: [], verdict: 'undeclared', note: null };
  }
  const lo = Math.min(...ests);
  const hi = Math.max(...ests);
  const classes = tiers.map((t) => t?.cost?.class).filter(Boolean);
  if (!Number.isFinite(measuredMsPerMp)) {
    return {
      declaredMinMsPerMp: lo,
      declaredMaxMsPerMp: hi,
      classes,
      verdict: 'unmeasured',
      note: "Declared but not measured this run — see this effect's `method` and `whyNotZoned`.",
    };
  }
  const ratio = measuredMsPerMp / hi;
  if (ratio > DECLARED_OVER_FACTOR) {
    return {
      declaredMinMsPerMp: lo,
      declaredMaxMsPerMp: hi,
      classes,
      verdict: 'over',
      ratioToDeclaredMax: round(ratio, 2),
      note: `MEASURED ${round(ratio, 2)}× the highest declared tier (${measuredMsPerMp} vs ${hi} ms/Mpx). Either the manifest estimate is wrong or the implementation drifted past it — the declaration has never been checked against a measurement before now.`,
    };
  }
  if (measuredMsPerMp < lo * 0.4) {
    return {
      declaredMinMsPerMp: lo,
      declaredMaxMsPerMp: hi,
      classes,
      verdict: 'under',
      ratioToDeclaredMax: round(ratio, 2),
      note: `Measured well under the declared estimate (${measuredMsPerMp} vs ${lo} ms/Mpx). Cheap to leave, but the declaration is pessimistic enough to be misleading in a budget.`,
    };
  }
  return {
    declaredMinMsPerMp: lo,
    declaredMaxMsPerMp: hi,
    classes,
    verdict: 'within',
    ratioToDeclaredMax: round(ratio, 2),
    note: null,
  };
}

/**
 * Roll zone rows up per effect, and cross-check against the sweep.
 *
 * `method` is the load-bearing field. An effect that draws inside somebody
 * else's scene render has no bracket of its own and can only ever be swept —
 * saying so is the difference between a breakdown and a guess.
 */
export function attributeZonesToEffects({
  rows = [],
  manifests = [],
  effectZoning = {},
  sweep = null,
  megapixels = null,
  enabledEffects = null,
} = {}) {
  const enabled = enabledEffects ? new Set(enabledEffects) : null;
  // ⚠️ READ THE PRODUCER'S SHAPE, DO NOT INVENT ONE. `perf-lab.js`'s runSweep
  // returns `{effects, configs, raw, summary}` where the COSTS live at
  // `summary.perEffect[].costMs`. `sweep.effects` also exists — it is
  // `harness.listEffects()`, an id/label list with no numbers on it at all.
  // The first version read `sweep.effects[].gpuMsDelta`: a real array, a field
  // that has never existed, so every lookup returned undefined and every effect
  // silently reported `sweepMarginalGpuMs: null` while `sweepIncluded` said
  // true. Live 2026-07-27, that wasted a full slow sweep run and produced
  // nothing — the exact thing the sweep was clicked for.
  const sweepById = new Map();
  const perEffect = sweep?.summary?.perEffect ?? sweep?.perEffect ?? [];
  for (const e of perEffect) if (e?.id) sweepById.set(e.id, e);
  // Self-calibrated from this sweep's own negative readings. See the function.
  const sweepNoiseFloorMs = estimateSweepNoiseFloor(perEffect);

  return manifests.map((manifest) => {
    const id = manifest.id;
    const owned = rows.filter((r) => r.ownerEffectId === id);
    const zoning = effectZoning[id] ?? null;

    // STEADY and SPARSE cost are different quantities and must never be added.
    // A bake amortised over 612 frames is not a per-frame shading cost, and
    // comparing it against a declared ms/Mpx (a steady-state per-pixel figure)
    // is a category error that produces a confident verdict about nothing.
    const steady = owned.filter((r) => !r.sparse);
    const sparse = owned.filter((r) => r.sparse);

    let zoneGpu = null;
    let zoneCpu = null;
    for (const r of steady) {
      const g = r.gpuMs?.amortisedMsPerFrame;
      if (Number.isFinite(g)) zoneGpu = (zoneGpu ?? 0) + g;
      const c = r.cpuMs?.amortisedMsPerFrame;
      if (Number.isFinite(c)) zoneCpu = (zoneCpu ?? 0) + c;
    }
    const sweepEntry = sweepById.get(id) ?? null;
    // `costMs` = solo-with-effect minus baseline. summarizeSweep already nulls
    // it when either side is unmeasured, so a null here is a real absence.
    const sweepRaw = Number.isFinite(sweepEntry?.costMs) ? sweepEntry.costMs : null;

    // REJECT WHAT THE SWEEP COULD NOT ACTUALLY RESOLVE. A negative cost is
    // physically impossible, and a positive one inside the noise band is the
    // same noise with a luckier sign — promoting either to a measurement is how
    // "vegetation costs -0.123 ms/Mpx, comfortably under budget" got printed as
    // a finding on 2026-07-27.
    let sweepUnresolvable = null;
    let sweepGpu = sweepRaw;
    if (sweepRaw !== null && sweepRaw < 0) {
      sweepUnresolvable = 'negative';
      sweepGpu = null;
    } else if (sweepRaw !== null && sweepNoiseFloorMs !== null && sweepRaw <= sweepNoiseFloorMs) {
      sweepUnresolvable = 'below-noise-floor';
      sweepGpu = null;
    }

    // `method` describes what produced a comparable GPU cost. A CPU-only zone
    // makes an effect "zoned", but it does NOT give a second GPU number, so
    // calling that 'both' would promise an agreement check that cannot exist.
    const hasGpuZone = zoneGpu !== null;
    const method =
      hasGpuZone && sweepGpu !== null
        ? 'both'
        : hasGpuZone
          ? 'zone'
          : sweepGpu !== null
            ? 'sweep'
            : zoneCpu !== null
              ? 'cpu-zone-only'
              : 'unmeasured';

    // COST OF RECORD. Where zoning is admittedly incomplete the zone sum
    // UNDERSTATES, so it must never be promoted to a total: the sweep wins if we
    // have one, and if we do not, the answer is NULL. Reporting the fragment we
    // happen to have measured, and then grading it against a declared budget,
    // manufactures confidence out of a known gap — which is the whole failure
    // this file exists to prevent.
    const incomplete = zoning?.coverage === 'partial' || zoning?.coverage === 'none';
    let costMs = null;
    let costBasis = null;
    if (incomplete) {
      if (sweepGpu !== null) {
        costMs = sweepGpu;
        costBasis = 'sweep';
      }
    } else if (hasGpuZone) {
      costMs = zoneGpu;
      costBasis = 'zones';
    } else if (sweepGpu !== null) {
      costMs = sweepGpu;
      costBasis = 'sweep';
    }

    const measuredMsPerMp =
      Number.isFinite(costMs) && Number.isFinite(megapixels) && megapixels > 0 ? round(costMs / megapixels, 3) : null;

    const sparseSummary = sparse.length === 0 ? null : summariseSparse(sparse);
    const declared = compareToManifest(measuredMsPerMp, manifest);
    if (declared.verdict === 'unmeasured' && incomplete && sweepGpu === null) {
      declared.note =
        `Not comparable this run: this effect's zone coverage is '${zoning.coverage}', so the zones that DID report ` +
        'are a fragment of its cost, not a total. Run the sweep for a marginal figure.';
    } else if (declared.verdict === 'unmeasured' && sparseSummary && !hasGpuZone) {
      declared.note = sparseSummary.bakeFired
        ? 'Not comparable this run: every zone this effect owns is a BAKE. A bake amortised over the window is not ' +
          'a per-megapixel shading cost — read sparse.peakMs and sparse.occurrences instead.'
        : "NOT MEASURED AT ALL this run: this effect's only zones are bakes, and none of them fired during the " +
          'window. sparse.occurrences counts the per-frame CHECK, not bakes — see sparse.note.';
    }

    return {
      id,
      label: manifest.title ?? id,
      enabled: enabled ? enabled.has(id) : null,
      method,
      zoneGpuMs: ms(zoneGpu),
      zoneCpuMs: ms(zoneCpu),
      sparse: sparseSummary,
      sweepMarginalGpuMs: ms(sweepGpu),
      // The rejected reading is kept, LABELLED, rather than hidden — so a reader
      // who wonders "why is the sweep column empty when I ran the sweep" gets an
      // answer instead of a gap.
      sweepRawMs: sweepUnresolvable === null ? null : ms(sweepRaw),
      sweepUnresolvable,
      sweepUnresolvableNote:
        sweepUnresolvable === 'negative'
          ? `The sweep measured ${ms(sweepRaw)}ms for this effect — a negative GPU cost, which is impossible. It is measurement noise, not a cost, and has been rejected rather than reported.`
          : sweepUnresolvable === 'below-noise-floor'
            ? `The sweep measured ${ms(sweepRaw)}ms, inside this run's own noise band of ±${ms(sweepNoiseFloorMs)}ms (derived from the most negative reading in the same sweep). Indistinguishable from zero — use zoneGpuMs where there is one.`
            : null,
      agreement: classifyAgreement(zoneGpu, sweepGpu, zoning),
      costMs: ms(costMs),
      costBasis,
      measuredMsPerMp,
      declared,
      zoneCoverage: zoning?.coverage ?? (owned.length > 0 ? 'full' : 'none'),
      whyNotZoned: zoning?.why ?? null,
      zones: owned.map((r) => r.id),
    };
  });
}

/**
 * Estimate the sweep's own noise floor, from the sweep's own results.
 *
 * ============================================================================
 * WHY THIS EXISTS — the sweep is a DIFFERENCE OF TWO LARGE NUMBERS
 * ============================================================================
 *
 * A sweep cost is `soloFrameGpu - baselineFrameGpu`, each a median of ~20
 * whole-frame samples. At a 21.6 ms frame, resolving a 0.1 ms effect means
 * resolving 0.5% of each measurement — far below the run-to-run variance of a
 * real GPU. The tell is unmistakable and it showed up on the first working
 * sweep (2026-07-27): **negative costs.** Vegetation -0.9 ms, doorGraphics
 * -1.1 ms, water -0.8 ms, and `uiWindowShadow` — which was DISABLED and has no
 * draw call at all by design — charged +0.6 ms.
 *
 * A negative GPU cost is physically impossible, so every negative reading is
 * pure noise, and its magnitude is a DIRECT, SELF-CALIBRATING lower bound on how
 * much noise this particular sweep carried. Anything inside ±that band is
 * unresolvable and must not be reported as a number.
 *
 * This is deliberately empirical rather than a tuned constant: the floor scales
 * with the machine, the scene and the frame cost, exactly as it should
 * (`feedback_probed_constants_vs_derived` — derive it once from the data, do not
 * hardcode a guess).
 *
 * @param {Array<{costMs?: number|null}>} perEffect
 * @returns {number|null} the floor in ms, or null when nothing went negative
 *   (in which case we have no evidence about the noise either way).
 */
export function estimateSweepNoiseFloor(perEffect) {
  if (!Array.isArray(perEffect) || perEffect.length === 0) return null;
  let worstNegative = 0;
  for (const e of perEffect) {
    const c = e?.costMs;
    if (Number.isFinite(c) && c < worstNegative) worstNegative = c;
  }
  return worstNegative < 0 ? Math.abs(worstNegative) : null;
}

/**
 * Roll a set of sparse (bake/event) zones into the only three numbers that mean
 * anything for work that does not run every frame: how often, how bad when it
 * does, and what it costs spread out. Deliberately NOT a mean over all frames.
 */
export function summariseSparse(rows) {
  let peak = null;
  let amortised = null;
  let occurrences = 0;
  for (const r of rows) {
    const p = Math.max(r.gpuMs?.maxMs ?? -Infinity, r.cpuMs?.maxMs ?? -Infinity);
    if (Number.isFinite(p)) peak = peak === null ? p : Math.max(peak, p);
    const a = (r.gpuMs?.amortisedMsPerFrame ?? 0) + (r.cpuMs?.amortisedMsPerFrame ?? 0);
    if (a > 0) amortised = (amortised ?? 0) + a;
    occurrences += r.gpuMs?.occurrences ?? r.cpuMs?.occurrences ?? 0;
  }

  // ⚠️ A `maybeBake()` BRACKET TIMES THE CHECK, NOT THE BAKE. These zones wrap a
  // "has anything changed? if so, rebake" call, so the bracket runs EVERY frame
  // and its occurrence count is the number of CHECKS. When the bake itself never
  // fires during the window there is no GPU work at all, and reporting
  // "occurrences: 600, peak 0.2ms" without saying so reads as "it baked 600
  // times and was cheap" — precisely backwards, and how a genuinely expensive
  // bake could hide behind the cost of its own early-return. Seen live
  // 2026-07-27 on sunShadows and water.
  const bakeFired = rows.some((r) => r.gpuMs !== null);
  const everyFrame = rows.every((r) => (r.occurrenceRate ?? 0) > 0.95);

  return {
    note: bakeFired
      ? 'Bake/event work. Cost-per-occurrence x occurrence-rate, never a per-frame median.'
      : everyFrame
        ? 'THE BAKE DID NOT FIRE during this window. These numbers are the cost of the per-frame CHECK (a few comparisons and an early return), NOT of a bake — occurrences counts checks, not bakes. To measure the real bake cost, change the sun angle or repaint the mask so it rebakes while profiling.'
        : 'Bake/event work that did not run during this window — nothing was measured.',
    bakeFired,
    measures: bakeFired ? 'bake' : 'check-only',
    peakMs: ms(peak),
    amortisedMsPerFrame: ms(amortised),
    occurrences,
    occurrencesAre: bakeFired ? 'bakes' : 'checks',
    zones: rows.map((r) => r.id),
  };
}

/**
 * Give every pass row its own residual: how much of the pass is accounted for by
 * declared sub-zones, and how much is the pass's own un-broken-down interior
 * (render-target switches, autoClear juggling, work nobody has bracketed yet).
 *
 * Without this a reader sees "geometry.world: 1.42ms" with no children and
 * cannot tell whether that means "nothing in it is expensive" or "nothing in it
 * is instrumented". Those are opposite conclusions.
 */
export function annotatePassResiduals(rows) {
  const passes = rows.filter((r) => r.isPass);
  for (const p of passes) {
    const children = rows.filter((r) => r.parent === p.id);
    let child = null;
    for (const c of children) {
      const g = c.gpuMs?.amortisedMsPerFrame;
      if (Number.isFinite(g)) child = (child ?? 0) + g;
    }
    // GPU attribution is EXCLUSIVE (see computeAttribution), so a pass row's own
    // gpuMs IS its residual — the draws inside it that no sub-zone bracketed.
    // The pass TOTAL must be derived by adding its children back on; it is never
    // measured directly. Treating it as inclusive is what made every pass read
    // `gpu: —` on the first live run while its children showed real numbers.
    const own = p.gpuMs?.amortisedMsPerFrame ?? null;
    const total = child === null && own === null ? null : (child ?? 0) + (own ?? 0);
    p.childCount = children.length;
    p.childGpuMs = ms(child);
    p.ownGpuMs = ms(own);
    p.totalGpuMs = ms(total);
    p.gpuIsExclusive = true;
    p.breakdownNote =
      children.length === 0
        ? 'No sub-zones are declared inside this pass, so its cost is a single opaque number. That is a gap in the taxonomy, not evidence that nothing in it is expensive.'
        : own !== null && total > 0 && own / total > 0.4
          ? `${pct((own / total) * 100)}% of this pass's GPU time is outside its declared sub-zones — the breakdown does not explain most of it.`
          : null;
  }
  return rows;
}

/**
 * Zone-sum vs sweep-marginal are two different quantities and are EXPECTED to
 * differ for an effect that changes downstream work. Divergence is information;
 * flattening it to pass/fail would throw that information away.
 */
export function classifyAgreement(zoneGpu, sweepGpu, zoning) {
  if (!Number.isFinite(zoneGpu) || !Number.isFinite(sweepGpu)) return null;
  const hi = Math.max(Math.abs(zoneGpu), Math.abs(sweepGpu));
  if (hi <= 0) return 'agree';
  const delta = Math.abs(zoneGpu - sweepGpu) / hi;
  if (delta <= AGREEMENT_TOLERANCE) return 'agree';
  if (zoning && zoning.coverage !== 'full') return 'diverge-expected';
  return 'disagree';
}

/**
 * Split rows into what the default report shows and what it summarises away.
 * Nothing is ever dropped silently — the collapsed block names every id and its
 * totals, so "I don't see my zone" always has an answer.
 */
export function collapseInsignificant(
  rows,
  { frameGpuMs = null, sharePct = COLLAPSE_SHARE_PCT, cpuMs = COLLAPSE_CPU_MS } = {}
) {
  const kept = [];
  const collapsed = [];
  for (const r of rows) {
    if (r.isPass || r.sparse) {
      kept.push(r);
      continue;
    }
    const g = r.gpuMs?.amortisedMsPerFrame ?? 0;
    const c = r.cpuMs?.amortisedMsPerFrame ?? 0;
    const share = Number.isFinite(frameGpuMs) && frameGpuMs > 0 ? (g / frameGpuMs) * 100 : 0;
    const insignificant = share < sharePct && c < cpuMs && r.detail;
    (insignificant ? collapsed : kept).push(r);
  }
  return {
    kept,
    collapsed: {
      note: collapsed.length
        ? `${collapsed.length} detail zones below ${sharePct}% of frame GPU and ${cpuMs}ms CPU, summed. Ask for verbosity:'full' to expand.`
        : 'Nothing was collapsed.',
      count: collapsed.length,
      // Null, not 0, when nothing was collapsed — "we summed nothing" and "the
      // sum was zero" are different statements and this file does not conflate
      // them anywhere else either.
      gpuMsTotal: collapsed.length ? ms(collapsed.reduce((a, r) => a + (r.gpuMs?.amortisedMsPerFrame ?? 0), 0)) : null,
      cpuMsTotal: collapsed.length ? ms(collapsed.reduce((a, r) => a + (r.cpuMs?.amortisedMsPerFrame ?? 0), 0)) : null,
      ids: collapsed.map((r) => r.id),
    },
  };
}

/**
 * The ranked "so what". A report that lists 24 numbers and no conclusion has
 * moved the work of reading it onto the reader; this is the part that answers
 * "where do I optimise?" in the order it should be answered.
 */
export function deriveFindings({
  attribution,
  rows,
  effects,
  frame,
  method,
  budgetMs,
  profilerAnomalies,
  gpuTimer,
  sweepRequested = false,
  sweepMeasuredCount = 0,
  sweepNoiseFloorMs = null,
  sweepRejectedCount = 0,
}) {
  const out = [];

  // INSTRUMENT FAULTS FIRST. If the tool misbehaved, that outranks anything it
  // measured — a reader who acts on a number produced by a broken bracket is
  // worse off than one who read nothing.
  if (profilerAnomalies?.unbalancedBrackets > 0) {
    out.push({
      severity: 'high',
      id: 'profiler-unbalanced-brackets',
      text: `${profilerAnomalies.unbalancedBrackets} mispaired begin/end bracket(s) were detected during this run. The affected zones' numbers are SUSPECT — an unterminated bracket does not crash, it quietly poisons that zone. This is a fault in the instrument, not in the renderer.`,
      evidence: { unbalancedBrackets: profilerAnomalies.unbalancedBrackets },
    });
  }
  if (profilerAnomalies?.passSlotOverflow > 0) {
    out.push({
      severity: 'medium',
      id: 'profiler-pass-slot-overflow',
      text: `The profiler ran out of pass-zone slots (${profilerAnomalies.passSlotOverflow} overflow(s)). Some passes were not measured at all, so attribution coverage below is understated.`,
      evidence: { passSlotOverflow: profilerAnomalies.passSlotOverflow },
    });
  }
  // A SWEEP THAT RAN AND PRODUCED NOTHING. The sweep is slow and visibly
  // flickers the scene, so it is never run by accident — if it yielded no
  // per-effect numbers, the run was wasted and the reader must be told rather
  // than left to notice a column of nulls. Live 2026-07-27: a shape mismatch
  // did exactly this, silently, while method.sweepIncluded still said true.
  if (sweepRequested && sweepMeasuredCount === 0) {
    out.push({
      severity: 'high',
      id: 'sweep-produced-nothing',
      text: 'The effect sweep was requested and ran, but produced no per-effect cost for ANY effect. That run was wasted — every effects[].sweepMarginalGpuMs is null, so the effects that can only be measured by sweep (vegetation, water, grade) are still unmeasured. Check the sweep harness wiring before re-running.',
      evidence: { sweepRequested: true, effectsMeasured: 0 },
    });
  } else if (sweepRequested && sweepMeasuredCount > 0 && effects?.length && sweepMeasuredCount < effects.length) {
    out.push({
      severity: 'low',
      id: 'sweep-partial',
      text: `The sweep produced costs for ${sweepMeasuredCount} of ${effects.length} effects. The rest have no marginal figure — usually because they were already disabled during the sweep.`,
      evidence: { effectsMeasured: sweepMeasuredCount, effectsTotal: effects.length },
    });
  }

  if (gpuTimer?.unattributedPasses > 0) {
    out.push({
      severity: 'low',
      id: 'gpu-passes-unattributed',
      text: `${gpuTimer.unattributedPasses} render pass(es) ran with no profiler zone open, so their GPU time is real but belongs to no zone. It is counted in the frame total and shows up in attribution.residualGpuMs — never folded into an arbitrary zone to make the sums look tidier.`,
      evidence: { unattributedPasses: gpuTimer.unattributedPasses },
    });
  }

  if (method?.gpu !== 'timestamp-query') {
    out.push({
      severity: 'high',
      id: 'gpu-attribution-unavailable',
      text: `Per-pass GPU timing is unavailable (method.gpu = '${method?.gpu ?? 'unknown'}'${method?.gpuReason ? `: ${method.gpuReason}` : ''}). Every zones[].gpuMs is null by necessity, not by measurement. The effects[] sweep column is the only GPU attribution in this report.`,
      evidence: { gpu: method?.gpu ?? null, reason: method?.gpuReason ?? null },
    });
  }
  if (method?.timestampPoolOverflowed) {
    out.push({
      severity: 'high',
      id: 'timestamp-pool-overflow',
      text: 'The GPU timestamp query pool overflowed during this window — three stops allocating queries once 1024 passes are outstanding and rendering continues silently. Zone GPU numbers after that point are missing, not zero, and coverage below is understated.',
      evidence: { poolOverflow: true },
    });
  }
  if (attribution?.verdict === 'unreliable' || attribution?.verdict === 'indicative') {
    out.push({
      severity: attribution.verdict === 'unreliable' ? 'high' : 'medium',
      id: 'attribution-coverage-low',
      text: attribution.note,
      evidence: { coverage: attribution.coverage, residualGpuMs: attribution.residualGpuMs },
    });
  }

  // The single biggest attributed cost, named.
  const leaves = (rows ?? []).filter((r) => !r.isPass && !r.sparse && Number.isFinite(r.gpuMs?.amortisedMsPerFrame));
  const top = [...leaves].sort((a, b) => b.gpuMs.amortisedMsPerFrame - a.gpuMs.amortisedMsPerFrame)[0];
  if (top && Number.isFinite(attribution?.frameGpuMs) && attribution.frameGpuMs > 0) {
    const share = pct((top.gpuMs.amortisedMsPerFrame / attribution.frameGpuMs) * 100);
    out.push({
      severity: share >= 30 ? 'high' : 'medium',
      id: 'dominant-zone',
      text: `${top.id} (${top.label}) is the single largest attributed zone at ${top.gpuMs.amortisedMsPerFrame}ms, ${share}% of frame GPU${top.drawCalls ? ` from ${top.drawCalls} draw calls` : ''}.`,
      evidence: { zone: top.id, gpuMs: top.gpuMs.amortisedMsPerFrame, pctOfFrameGpu: share, drawCalls: top.drawCalls },
    });
  }

  // Sparse spikes: cheap on average, brutal on the one frame they land.
  for (const r of (rows ?? []).filter((x) => x.sparse)) {
    const peak = r.gpuMs?.maxMs ?? r.cpuMs?.maxMs ?? null;
    if (Number.isFinite(peak) && Number.isFinite(budgetMs) && peak > budgetMs) {
      out.push({
        severity: 'medium',
        id: `sparse-spike:${r.id}`,
        text: `${r.id} ran ${r.gpuMs?.occurrences ?? r.cpuMs?.occurrences ?? 0} times and peaked at ${peak}ms — over the ${budgetMs}ms frame budget on its own. Amortised it is negligible (${r.gpuMs?.amortisedMsPerFrame ?? r.cpuMs?.amortisedMsPerFrame}ms/frame); as a one-frame stall it is a visible hitch.`,
        evidence: { zone: r.id, peakMs: peak, occurrences: r.gpuMs?.occurrences ?? r.cpuMs?.occurrences ?? 0 },
      });
    }
  }

  // Passes the taxonomy cannot break down. This is a gap in the INSTRUMENT, and
  // it is worth saying out loud: a reader who cannot see inside an expensive
  // pass will otherwise conclude the cost is irreducible.
  for (const p of (rows ?? []).filter((r) => r.isPass && r.breakdownNote)) {
    // Use the pass's TOTAL (own + children); `gpuMs` alone is only its
    // un-bracketed residual under exclusive attribution.
    const total = Number.isFinite(p.totalGpuMs) ? p.totalGpuMs : null;
    const share =
      Number.isFinite(attribution?.frameGpuMs) && attribution.frameGpuMs > 0 && total !== null
        ? pct((total / attribution.frameGpuMs) * 100)
        : null;
    // A pass we could not price, or one that is cheap, earns no finding. The
    // first version skipped only when `share < 10`, so a NULL share fell through
    // and printed the literal string "null% of frame GPU" — the report doing the
    // exact thing it tells every other number not to do. Seen live 2026-07-27 on
    // pass.surface.particles, which was disabled and cost nothing at all.
    if (share === null || share < 10) continue;
    out.push({
      severity: 'low',
      id: `pass-not-broken-down:${p.id}`,
      text: `${p.id} is ${share}% of frame GPU. ${p.breakdownNote}`,
      evidence: { pass: p.id, totalGpuMs: total, childCount: p.childCount, ownGpuMs: p.ownGpuMs },
    });
  }

  // Declared cost classes that measurement contradicts.
  for (const e of effects ?? []) {
    if (e.declared?.verdict === 'over') {
      out.push({
        severity: 'high',
        id: `declared-cost-understated:${e.id}`,
        text: `${e.id}: ${e.declared.note}`,
        evidence: {
          effect: e.id,
          measuredMsPerMp: e.measuredMsPerMp,
          declaredMaxMsPerMp: e.declared.declaredMaxMsPerMp,
          classes: e.declared.classes,
        },
      });
    }
  }

  // THE SWEEP'S OWN RESOLUTION. Stated before any per-effect sweep number is
  // read, because it decides which of them mean anything at all.
  if (sweepNoiseFloorMs !== null) {
    const severity = sweepRejectedCount > (effects?.length ?? 0) / 2 ? 'high' : 'medium';
    out.push({
      severity,
      id: 'sweep-below-resolution',
      text:
        `The effect sweep cannot resolve anything cheaper than about ${sweepNoiseFloorMs}ms on this run — that floor is ` +
        `measured from its own most-negative reading, and a negative GPU cost is impossible. ` +
        `${sweepRejectedCount} of ${effects?.length ?? 0} effects fell inside it and had their sweep number REJECTED ` +
        `(see effects[].sweepUnresolvable). The sweep diffs two whole-frame medians, so it can only see effects that ` +
        `are large relative to the whole frame; for everything else the per-zone GPU timer is both finer and more ` +
        `direct. Trust zoneGpuMs over sweepMarginalGpuMs wherever both exist.`,
      evidence: { noiseFloorMs: sweepNoiseFloorMs, rejected: sweepRejectedCount, effects: effects?.length ?? 0 },
    });
  }

  // Methods that disagree without an explanation. Only where the sweep produced
  // a value we actually believe — comparing a zone against rejected noise would
  // manufacture a contradiction out of nothing.
  for (const e of effects ?? []) {
    if (e.agreement === 'disagree') {
      out.push({
        severity: 'medium',
        id: `method-disagreement:${e.id}`,
        text: `${e.id}: zone sum ${e.zoneGpuMs}ms vs sweep marginal ${e.sweepMarginalGpuMs}ms — beyond the ${AGREEMENT_TOLERANCE * 100}% tolerance, and this effect declares FULL zone coverage, so one of the two is wrong. Do not average them.`,
        evidence: { effect: e.id, zoneGpuMs: e.zoneGpuMs, sweepMarginalGpuMs: e.sweepMarginalGpuMs },
      });
    }
  }

  if (Number.isFinite(frame?.hitches?.count) && frame.hitches.count > 0) {
    out.push({
      severity: frame.hitches.count > 5 ? 'medium' : 'low',
      id: 'hitches',
      text: `${frame.hitches.count} hitch${frame.hitches.count === 1 ? '' : 'es'} over ${frame.hitches.thresholdMs}ms during the window. Cross-reference the worst against the sparse zones above before blaming a steady one.`,
      evidence: { count: frame.hitches.count, thresholdMs: frame.hitches.thresholdMs },
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** The reading order, stated. Every report in this codebase ends with one. */
function buildInterpretation({ attribution, method }) {
  return [
    `READ attribution.verdict FIRST ('${attribution.verdict}'). It decides whether the rest of this report is a partition of the frame or a lower bound.`,
    `'good' (coverage >= ${COVERAGE_GOOD}): zones[] is a trustworthy breakdown — optimise the top row.`,
    `'indicative' (>= ${COVERAGE_UNRELIABLE}): a large slice is unattributed; use effects[].sweepMarginalGpuMs, which is measured independently of zone timing.`,
    `'unreliable' or 'unmeasured': treat every zone number as "at least this much" and fix the instrument before trusting the picture — findings[] will say what broke.`,
    `THEN read findings[] top-down; it is sorted by severity and already names the single largest cost.`,
    `THEN frame.gapMs vs frame.gpuMs: if gap p95 is far above gpu p95 the bottleneck is CPU or presentation, not shading, and the zones[].cpuMs column is where to look.`,
    `A null is an ABSENCE, never a zero. zones[].gpuAbsentByDeclaration true means the zone contains no draw calls at all; null with that flag false means measurement failed.`,
    `Sparse zones (cadence 'bake'/'event') are excluded from per-frame sums by construction — read their occurrenceRate and maxMs, never their mean, and see findings[] for any that spike over budget.`,
    method?.cpuClockResolutionMs
      ? `CPU means below ${method.cpuClockResolutionMs}ms/sqrt(12n) are listed in belowClockResolution[] with no number attached; the clock physically cannot resolve them and a number there would be noise dressed as a measurement.`
      : `The CPU clock resolution was not measured this run, so no noise floor was applied — treat small CPU means with suspicion.`,
  ].join(' ');
}

/**
 * Build the whole report. Pure: every input is passed in, including the
 * timestamp, so this is deterministic and fully Node-testable.
 */
export function buildPerfReport({
  generatedAt = null,
  msaVersion = null,
  codename = null,
  window: win = {},
  method = {},
  zoneStats = [],
  zones = [],
  effectZoning = {},
  frame = {},
  sweep = null,
  manifests = [],
  enabledEffects = null,
  vram = null,
  budgetMs = null,
  verbosity = 'default',
  profilerAnomalies = null,
  gpuTimer = null,
} = {}) {
  const frames = Number.isFinite(win.frames) ? win.frames : 0;
  const megapixels =
    Number.isFinite(win.resolution?.w) && Number.isFinite(win.resolution?.h)
      ? round((win.resolution.w * win.resolution.h) / 1e6, 2)
      : null;

  const allRows = annotatePassResiduals(
    buildZoneRows({ zoneStats, zones, frames, clockResolutionMs: method.cpuClockResolutionMs ?? null })
  );
  const gapSamples = Array.isArray(frame.gapSamples) ? frame.gapSamples : [];
  const frameGpuMs = Number.isFinite(frame.gpuMs?.p50) ? frame.gpuMs.p50 : (frame.gpuMs?.gpuMsMedian ?? null);

  const attribution = computeAttribution({ frameGpuMs, rows: allRows });
  // Say what the denominator actually IS. "Coverage 0.93" means nothing until
  // the reader knows whether the 1.0 is the whole GPU frame or only the part of
  // it three timestamps.
  attribution.frameGpuBasis = frame.gpuMs?.basis ?? null;
  attribution.frameGpuCaveat = frame.gpuMs?.caveat ?? null;

  const effects = attributeZonesToEffects({
    rows: allRows,
    manifests,
    effectZoning,
    sweep,
    megapixels,
    enabledEffects,
  });

  const sorted = [...allRows].sort((a, b) => (b.gpuMs?.amortisedMsPerFrame ?? 0) - (a.gpuMs?.amortisedMsPerFrame ?? 0));
  const full = verbosity === 'full';
  const { kept, collapsed } = full
    ? {
        kept: sorted,
        collapsed: {
          note: 'verbosity:full — nothing collapsed.',
          count: 0,
          gpuMsTotal: null,
          cpuMsTotal: null,
          ids: [],
        },
      }
    : collapseInsignificant(sorted, { frameGpuMs: attribution.frameGpuMs });

  const belowClock = allRows.filter((r) => r.belowClockResolution);

  const hitchItems = Array.isArray(frame.hitches) ? frame.hitches : [];
  const hitchCap = full ? hitchItems.length : HITCHES_KEPT;
  const frameBlock = {
    // THE HEADLINE, FIRST — worst / best / average across the whole window, per
    // the author's directive. Everything below it is detail on top of these.
    fps: summariseFrameRate(gapSamples, { durationMs: win.durationMs ?? null }),
    hangs: findHangs(gapSamples, {
      keep: full ? Number.MAX_SAFE_INTEGER : HITCHES_KEPT,
      medianMs: percentileOf(gapSamples, 0.5),
    }),
    gapMs: summariseSamples(gapSamples),
    gpuMs: frame.gpuMs ?? null,
    cpuEncodeMs: frame.cpuEncodeMs ?? null,
    gapSampleCoverage:
      frame.gapDropped > 0
        ? `${gapSamples.length} of ${gapSamples.length + frame.gapDropped} frames — the gap ring wrapped, so the OLDEST ${frame.gapDropped} frames are missing from every statistic above.`
        : 'every frame in the window',
    histogram: buildHistogram(gapSamples),
    shape: condenseFrameHistory(gapSamples, { durationMs: win.durationMs ?? null }),
    hitches: {
      thresholdMs: frame.hitchThresholdMs ?? null,
      count: hitchItems.length,
      kept: Math.min(hitchCap, hitchItems.length),
      dropped: Math.max(0, hitchItems.length - hitchCap) + (frame.hitchesDropped ?? 0),
      items: [...hitchItems].sort((a, b) => (b.gapMs ?? 0) - (a.gapMs ?? 0)).slice(0, hitchCap),
    },
  };

  const sweepMeasuredCount = effects.filter((e) => e.sweepMarginalGpuMs !== null).length;
  const sweepNoiseFloorMs = estimateSweepNoiseFloor(sweep?.summary?.perEffect ?? sweep?.perEffect ?? []);
  const sweepRejectedCount = effects.filter((e) => e.sweepUnresolvable !== null).length;
  const findings = deriveFindings({
    attribution,
    rows: allRows,
    effects,
    frame: frameBlock,
    method,
    budgetMs,
    profilerAnomalies,
    gpuTimer,
    sweepRequested: sweep !== null,
    sweepMeasuredCount,
    sweepNoiseFloorMs,
    sweepRejectedCount,
  });

  return {
    report: 'perf-profile',
    formatVersion: 1,
    generatedAt,
    msaVersion,
    codename,
    method: {
      gpu: method.gpu ?? 'none',
      gpuReason: method.gpuReason ?? null,
      cpuClockResolutionMs: method.cpuClockResolutionMs ?? null,
      // REQUESTED vs DELIVERED are different facts. `sweepIncluded: true` while
      // every column was null is precisely the lie this pair exists to prevent.
      sweepRequested: sweep !== null,
      sweepEffectsMeasured: sweepMeasuredCount,
      sweepEffectsRejected: sweepRejectedCount,
      // Measured from the sweep's own most-negative reading. Null means nothing
      // went negative, which is evidence of a clean sweep — not proof of one.
      sweepNoiseFloorMs,
      sweepIncluded: sweep !== null && sweepMeasuredCount > 0,
      route: method.route ?? null,
      timestampPoolOverflowed: method.timestampPoolOverflowed ?? false,
      zoneStatsNote:
        'Zones report mean/max/amortised over the window, NOT percentiles. Per-zone percentiles would require ' +
        'retaining a per-frame sample per zone, which this profiler deliberately does not do — it stays ' +
        'zero-allocation while armed so the instrument does not create the GC hitches it is measuring. ' +
        'Percentiles are frame-level, where the samples already exist.',
    },
    window: {
      frames,
      durationMs: ms(win.durationMs ?? null),
      settleFramesDiscarded: win.settleFramesDiscarded ?? null,
      resolution: win.resolution ?? null,
      megapixels,
      sceneName: win.sceneName ?? null,
      floorIndex: win.floorIndex ?? null,
      loop: win.loop ?? 'viewer',
    },
    frame: frameBlock,
    attribution,
    zones: kept,
    zonesCollapsed: collapsed,
    belowClockResolution: {
      note:
        "Mean is under the clock's own noise floor (resolution / sqrt(12n)). These zones RAN — they are " +
        'reported as present with no number, because a number here would be quantisation noise, which is the ' +
        'same lie as reporting 0 for "not measured".',
      ids: belowClock.map((r) => r.id),
    },
    effects,
    vram,
    // INSTRUMENT HEALTH, kept separate from the measurements on purpose. An
    // unbalanced bracket or an overflowed query pool is a fault in the tool, and
    // reading it as a property of the renderer would send someone hunting a bug
    // that is not there.
    instrument: {
      profilerAnomalies,
      gpuTimer,
      note:
        'These describe the INSTRUMENT, not the renderer. Non-zero unbalancedBrackets or poolOverflowed ' +
        'means some numbers above are missing or suspect — fix the instrument before drawing conclusions.',
    },
    findings,
    interpretation: buildInterpretation({
      attribution,
      method: { ...method, cpuClockResolutionMs: method.cpuClockResolutionMs ?? null },
    }),
  };
}

/** Budget for a pass id, falling back to the strict default. */
export function budgetForPass(passId, budgets) {
  return budgets?.[passId] ?? DEFAULT_PASS_BUDGET_MS;
}

export { medianOf, percentileOf };
