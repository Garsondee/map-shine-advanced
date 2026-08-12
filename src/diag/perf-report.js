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
// MOVED to perf-lab.js 2026-08-06 (the sweep's own module — this is entirely
// about interpreting the SWEEP's noise, not the zone/effect merge this file
// does) and re-exported here for backward compatibility. `summarizeSweep`
// (perf-lab.js) now calls this SAME function internally so the standalone
// sweep display and this file's `effects[]` attribution can never disagree
// about which readings are trustworthy — see that file's own history for the
// live report that caught them disagreeing.
import { estimateSweepNoiseFloor } from './perf-lab.js';
export { estimateSweepNoiseFloor };

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

/**
 * IS THIS FRAME GPU-BOUND OR NOT? — the first question anyone asks, answered.
 *
 * Until 2026-08-12 this report computed both halves of the answer and then told
 * the READER to do the division: *"THEN frame.gapMs vs frame.gpuMs: if gap p95
 * is far above gpu p95 the bottleneck is CPU or presentation"* (the
 * interpretation string, still there, now backed by this). That instruction was
 * followed correctly at least twice and skipped silently more often than that —
 * a verdict a tool can compute must not be left as an exercise.
 *
 * ⚠️ TWO PERCENTILES, NOT ONE, BECAUSE THEY ROUTINELY DISAGREE. A frame can be
 * GPU-bound at the median and CPU-bound in the tail, and that combination has a
 * completely different fix from either pure case (shrink the shader vs. find the
 * stall). Reporting only p50 hides every hitch; reporting only p95 makes a
 * healthy median look broken. Both, always, separately labelled.
 *
 * ⚠️ THE RESIDUAL IS NOT "CPU TIME", AND THIS FUNCTION MUST NOT CALL IT THAT.
 * `frame.gpuMs` is the sum of TIMESTAMPED RENDER PASSES (its own `basis` field
 * says so). Mipmap generation, presentation/swap, and any GPU work outside a
 * render pass are real GPU cost that is NOT in that number. So gap − gpu is
 * "time the measured passes do not explain", whose candidates are CPU work,
 * presentation, AND untimestamped GPU work — three different bugs. Naming one of
 * them here would be the `feedback_aggregate_cannot_name_the_source` error with
 * extra confidence.
 */
export const GPU_BOUND_FRACTION = 0.85;
export const CPU_BOUND_FRACTION = 0.6;

export function classifyBottleneck({ gapMs = null, gpuMs = null } = {}) {
  const at = (p) => {
    const gap = gapMs?.[p];
    const gpu = gpuMs?.[p];
    if (!Number.isFinite(gap) || gap <= 0 || !Number.isFinite(gpu)) return null;
    const explained = gpu / gap;
    return {
      gapMs: ms(gap),
      gpuMs: ms(gpu),
      unexplainedMs: ms(gap - gpu),
      gpuFraction: round(explained, 3),
      verdict:
        explained >= GPU_BOUND_FRACTION ? 'gpu-bound' : explained >= CPU_BOUND_FRACTION ? 'mixed' : 'not-gpu-bound',
    };
  };
  const median = at('p50');
  const tail = at('p95');
  if (median === null && tail === null) {
    return {
      verdict: 'unmeasured',
      median: null,
      tail: null,
      note:
        'Neither the frame gap nor the per-pass GPU total was measurable this run, so no bottleneck verdict is ' +
        'possible. This is an ABSENCE, not a "balanced" frame — check method.gpu first.',
    };
  }
  // The HEADLINE verdict is the median's, because that is the felt frame rate.
  // The tail is reported beside it and drives its own sentence when it differs,
  // rather than being averaged into a single misleading word.
  const verdict = median?.verdict ?? tail?.verdict ?? 'unmeasured';
  const split = median !== null && tail !== null && median.verdict !== tail.verdict;
  return {
    verdict,
    median,
    tail,
    tailDiffers: split,
    note:
      (verdict === 'gpu-bound'
        ? 'GPU-BOUND at the median: the timestamped render passes account for most of the frame, so zones[] is where the frame time actually is — optimise the top row.'
        : verdict === 'mixed'
          ? 'MIXED at the median: a substantial slice of the frame is not explained by the timestamped render passes. Read zones[].cpuMs beside zones[].gpuMs — the answer is in both columns.'
          : 'NOT GPU-BOUND at the median: most of the frame is NOT inside a timestamped render pass. Shrinking a shader will not move this — look at zones[].cpuMs, and at anything outside a render pass entirely.') +
      (split
        ? ` The TAIL DISAGREES WITH THE MEDIAN (p95 is '${tail.verdict}', p50 is '${median.verdict}') — these have different fixes, and this run needs both. The median says what the steady frame costs; the p95 says what the hitches are made of.`
        : '') +
      ' The unexplained remainder is NOT proven to be CPU time: mipmap generation, presentation and any GPU work outside a render pass are all real GPU cost that frame.gpuMs does not count (see its own `basis`/`caveat`). Three candidates, not one.',
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
    // Computed once, reused below for every field this declaration covers —
    // not just gpuMs (see the drawCalls/triangles comment further down).
    const gpuAbsentByDeclaration = (decl?.kind ?? 'gpu') === 'cpu';
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
      gpuAbsentByDeclaration,
      occurrenceRate: frames > 0 ? round(stat.cpu?.count || stat.gpu?.count || 0, 0) / frames : null,
      belowClockResolution: cpu !== null && floor !== null && cpu.meanMs !== null && cpu.meanMs < floor,
      clockNoiseFloorMs: floor === null ? null : ms(floor),
      // SUPPRESSED FOR 'cpu' ZONES (2026-08-11, Residency-Streaming-Audit
      // §2/§6.1) — this is `gpuAbsentByDeclaration`'s OWN promise, made in this
      // file's interpretation note ("gpuAbsentByDeclaration true means the
      // zone contains no draw calls at all") but never actually enforced here
      // until now. frame-profiler.js's openSlot/closeSlot sample
      // renderer.info.render.drawCalls/triangles UNCONDITIONALLY at every
      // zone's begin/end, with no check of the zone's declared kind. A zone
      // whose bracket spans a real `await` (residency's own sequential
      // per-item load chain, most visibly) can close after one or more
      // UNRELATED frames rendered during the wait — three's own counters
      // reset every rAF tick, so the sampled delta is THEIR draws, not this
      // zone's, and lands in a plausible-looking range instead of reading as
      // the noise it is. Confirmed live: `residency.itemLoad` — genuinely
      // zero draws of its own — reported 365 draw calls / 428k triangles.
      // A 'gpu'/'both' zone genuinely issues draws, so its numbers pass
      // through unchanged; only 'cpu' is suppressed, matching the exact set
      // gpuAbsentByDeclaration already names.
      drawCalls: gpuAbsentByDeclaration ? null : avgOf(stat.drawCalls),
      triangles: gpuAbsentByDeclaration ? null : avgOf(stat.triangles),
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
  // Self-calibrated: the larger of this sweep's own negative readings and its
  // directly-measured bracketing-baseline drift. See the function.
  const sweepNoiseFloorMs = estimateSweepNoiseFloor(perEffect, sweep?.summary?.noiseFloorMs ?? null);

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
  bottleneck = null,
  structuralAB = null,
  profilerAnomalies,
  gpuTimer,
  pipelineStats = null,
  depthProxyPoolStats = null,
  shaderRebuildStats = null,
  sweepRequested = false,
  sweepMeasuredCount = 0,
  sweepNoiseFloorMs = null,
  sweepRejectedCount = 0,
}) {
  const out = [];

  // INSTRUMENT FAULTS FIRST. If the tool misbehaved, that outranks anything it
  // measured — a reader who acts on a number produced by a broken bracket is
  // worse off than one who read nothing.

  // A 'cpu' ZONE THAT CARRIES GPU TIME IS A MISLABELLED MEASUREMENT (2026-08-12).
  // GPU timestamps are attributed to whichever zone is innermost-open when the
  // render fires. A `kind:'gpu'` zone that opens a `kind:'cpu'` sub-zone around
  // its own `renderer.render()` call therefore hands its entire GPU cost to the
  // child and reports `gpuMs: null` itself — which this report renders as
  // "measurement failed", the exact opposite of what happened.
  //
  // This cost three separate investigations the same rediscovery (P-007 filed it
  // as "an unexplained outlier for three rounds"; P-008 Finding 3 traced the
  // mechanism; the 2026-08-12 capture hit it again) before anyone wrote it down
  // somewhere the tool itself would say it. gpu-zone-timer.js now walks to the
  // nearest GPU-kind ancestor so this should not recur — this finding is the
  // GUARD that stays behind, because the next zone nested this way will be
  // written by someone who has not read that fix.
  for (const r of rows ?? []) {
    const gpu = r.gpuMs?.amortisedMsPerFrame;
    if (!r.gpuAbsentByDeclaration || !Number.isFinite(gpu) || gpu <= 0) continue;
    out.push({
      severity: 'high',
      id: `zone-kind-contradiction:${r.id}`,
      text: `${r.id} is declared kind:'cpu' (gpuAbsentByDeclaration: true, meaning "this zone contains no draw calls at all") yet carries ${gpu}ms/frame of real GPU time. Both cannot be true. Either the declaration is wrong, or a GPU timestamp landed here because this zone was the innermost bracket open around somebody else's renderer.render() call — in which case that GPU time belongs to an ancestor and the ancestor is reporting a misleading gpuMs: null.`,
      evidence: { zone: r.id, gpuMsPerFrame: gpu, site: r.site, parent: r.parent },
    });
  }

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
  // PIPELINE GROWTH DURING A STEADY WINDOW (2026-08-09) — a scene that is only
  // panning, not loading new content, should compile a HANDFUL of shader
  // pipelines once and reuse them (buildSceneDepthWriterMaterial's own header:
  // "a handful of variants, not one per item"). If `programs` is higher at the
  // end of the window than the start, this renderer is still compiling
  // pipelines it should already have, every pass — a real, live-measured cost
  // this project has hit before (that same header: "3.4ms mean/43ms max CPU"
  // from exactly this cause), not a one-time historical footnote. Any growth
  // is worth surfacing; only a double-digit delta is escalated to `high`,
  // since a rebuild or two during the settle-adjacent frames is plausible
  // and not yet proof of a live leak.
  if (Number.isFinite(pipelineStats?.start?.programs) && Number.isFinite(pipelineStats?.end?.programs)) {
    const delta = pipelineStats.end.programs - pipelineStats.start.programs;
    if (delta > 0) {
      out.push({
        severity: delta >= 10 ? 'high' : 'medium',
        id: 'pipeline-programs-grew',
        text: `renderer.info.memory.programs grew by ${delta} (${pipelineStats.start.programs} → ${pipelineStats.end.programs}) during a measurement window that should only be panning, not loading new content. A steady scene should compile a handful of shader pipelines once and reuse them — growth here means something is still forcing a fresh pipeline compile, a real CPU cost this project has measured before (buildSceneDepthWriterMaterial's own header: "3.4ms mean/43ms max CPU" from exactly this cause).`,
        evidence: {
          programsStart: pipelineStats.start.programs,
          programsEnd: pipelineStats.end.programs,
          delta,
        },
      });
    }
  }
  // UNIFORM-BUFFER GROWTH (2026-08-12) — P-008's own "open lead, not investigated
  // this round" (uniformBuffers 2,137 → 8,637, 4.04×, while `programs` held flat
  // at 84). It stayed uninvestigated partly because nothing surfaced it: the raw
  // pair was printed under instrument.pipelineStats and no finding ever pointed
  // at it, so it read as background detail rather than a question. The
  // 2026-08-12 capture repeated it (5,607 → 17,539, 3.1×) and it was STILL
  // nobody's finding.
  //
  // ⚠️ DELIBERATELY NOT CALLED A LEAK. Growth here is genuinely ambiguous:
  // per-material/per-light UBO allocation scaling with new content entering
  // residency is expected and benign, and this report cannot tell that apart
  // from unbounded per-frame allocation. What it CAN do is refuse to let the
  // question go unasked for a third capture running. Ratio-based, not
  // delta-based — an absolute count means nothing without its starting point.
  if (Number.isFinite(pipelineStats?.start?.uniformBuffers) && Number.isFinite(pipelineStats?.end?.uniformBuffers)) {
    const from = pipelineStats.start.uniformBuffers;
    const to = pipelineStats.end.uniformBuffers;
    const ratio = from > 0 ? to / from : null;
    if (ratio !== null && ratio >= 2) {
      out.push({
        severity: 'medium',
        id: 'uniform-buffers-grew',
        text: `renderer.info.memory.uniformBuffers grew ${round(ratio, 2)}× (${from} → ${to}) across the measurement window. Whether that is expected (per-material/per-light UBOs allocated as new content enters residency, torn down between passes) or an unbounded per-frame allocation is NOT decided here — this report cannot tell those apart. It is flagged because the same growth appeared in the 2026-08-11 capture (4.04×) and went uninvestigated for want of anyone naming it. To settle it: re-run a window with the camera parked so no new content streams in. If the ratio holds with a static view, it is per-frame allocation, not content.`,
        evidence: { uniformBuffersStart: from, uniformBuffersEnd: to, ratio: round(ratio, 2) },
      });
    }
  }
  // DEPTH-PROXY MATERIAL POOL HEALTH (DEFERRED-S1b, 2026-08-11) — the direct
  // proof-of-work for the fix that closes the SAME cost class
  // pipeline-programs-grew above exists to catch (buildSceneDepthWriterMaterial's
  // own header, again: "a handful of variants, not one per item"). Delta
  // across the window, same reasoning as pipelineStats: lifetime counters
  // mean only start-vs-end says anything about THIS run.
  if (Number.isFinite(depthProxyPoolStats?.start?.hits) && Number.isFinite(depthProxyPoolStats?.end?.hits)) {
    const hits = depthProxyPoolStats.end.hits - depthProxyPoolStats.start.hits;
    const misses = depthProxyPoolStats.end.misses - depthProxyPoolStats.start.misses;
    const evictions = depthProxyPoolStats.end.evictions - depthProxyPoolStats.start.evictions;
    const total = hits + misses;
    if (total > 0) {
      const hitRatePct = round((hits / total) * 100, 1);
      // A LOW hit rate on a window that had real residency-pass activity
      // (total > 0 already establishes that) means something is churning the
      // pool's own signature every pass — a material variant flipping, or a
      // genuine burst of new content — either way worth a look, not silence.
      // Not escalated past 'medium': a cold-start burst of misses right after
      // settling is expected and this finding cannot yet tell that apart from
      // a real leak (see this block's own evidence, which reports the raw
      // counts so a reader can).
      out.push({
        severity: hitRatePct < 50 ? 'medium' : 'low',
        id: 'depth-proxy-pool-health',
        text: `The depth-proxy material pool served ${hits} cache hit(s) and ${misses} miss(es) (${hitRatePct}% hit rate) during this window, evicting ${evictions} stale entr${evictions === 1 ? 'y' : 'ies'}. ${hitRatePct < 50 ? 'A hit rate under 50% during ordinary panning suggests something is still forcing a fresh material — check whether a variant (alwaysOpaque, floorIndex, flags) is flipping every pass rather than staying stable.' : "A healthy hit rate means rebuildSceneDepthProxies is reusing materials instead of paying a shader-graph rebuild for each one — see the Testament's DEFERRED-S1b for the mechanism this replaced."}`,
        evidence: { hits, misses, evictions, hitRatePct },
      });
    }
  }
  // SHADER-REBUILD CHURN (2026-08-11) — the general form of the check above:
  // depth-proxy-pool-health can only see churn INSIDE that one pool, and the
  // bug that motivated this ("vegetation was excluded from the pool, so its
  // churn was invisible to the pool's own health check by definition") is
  // exactly why a narrower instrument isn't enough. This one watches three's
  // OWN shader-graph cache directly, so it catches a rebuild regardless of
  // which subsystem caused it — pooled, unpooled, not built yet.
  //
  // NOT hedged the way depth-proxy-pool-health is: that finding stays at
  // 'medium' because a cold-start burst of misses right after settling is
  // expected and it cannot yet tell that apart from a real leak. This probe
  // does not have that ambiguity — `materialChanged`/`nodesChanged` only ever
  // count the SECOND-and-later miss for a given label (shader-rebuild-probe.js
  // `recordMiss`: classification is skipped until there is a previous
  // observation to compare against), so a nonzero value here is never a
  // one-time settle cost. It is, by construction, a REPEAT rebuild of
  // something that already built once this window — which a healthy pooled
  // or stable material should never do. High severity, unconditionally.
  if (shaderRebuildStats?.installed === true && Array.isArray(shaderRebuildStats.labels)) {
    const churning = shaderRebuildStats.labels.filter((l) => l.materialChanged > 0 || l.nodesChanged > 0);
    if (churning.length > 0) {
      const worst = churning[0]; // the probe itself sorts worst-first
      // NAME THE DOMINANT CAUSE, not every cause present. A label can carry a
      // handful of stray nodesChanged alongside hundreds of materialChanged
      // (or the reverse) — hedging with "both X and Y" every time a second
      // count is merely nonzero reads as equally likely when one obviously
      // dominates, and it is the DOMINANT one that decides which fix actually
      // moves the number. Ties favour materialChanged: pooling still closes
      // half the gap even on an even split, where "stop rebuilding nodes"
      // alone would not touch the material-identity half at all.
      const materialDominant = worst.materialChanged >= worst.nodesChanged;
      const cause = materialDominant ? 'a NEW material object' : 'the SAME material with a rebuilt node graph';
      const fix = materialDominant
        ? 'pool/reuse the material (the shape vt/depth-proxy-material-pool.js already uses)'
        : 'stop rebuilding its nodes — pooling the material would change nothing here';
      out.push({
        severity: 'high',
        id: 'shader-rebuild-churn',
        text: `${worst.label} rebuilt three's TSL node graph ${worst.materialChanged + worst.nodesChanged} time(s) beyond its first build this window — mostly ${cause} (${worst.materialChanged} material-changed, ${worst.nodesChanged} nodes-changed). Full NodeBuilder.build() is expensive (measured elsewhere in this project at 40-67% of a frame) and renderer.info.programs will NOT show this: three caches pipelines by generated shader source, so a regenerated-but-identical graph allocates no new program while still paying to be regenerated. Fix: ${fix}.`,
        evidence: {
          label: worst.label,
          materialChanged: worst.materialChanged,
          nodesChanged: worst.nodesChanged,
          distinctCacheKeys: worst.distinctCacheKeys,
          otherChurningLabels: churning.length - 1,
        },
      });
    }
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
      // maxPendingSize/maxResolveSkipStreak added 2026-08-09 (gpu-zone-timer.js)
      // — undefined on an older report shape, so left OUT rather than forced to
      // a misleading 0 (feedback_instruments_must_not_lie). A high
      // maxResolveSkipStreak right before the overflow points at a stuck
      // resolveTimestampsAsync (a GPU backlog), not a missed collect() call —
      // see that file's own header for the hypothesis this was added to test.
      evidence: {
        poolOverflow: true,
        ...(gpuTimer?.maxPendingSize !== undefined ? { maxPendingSize: gpuTimer.maxPendingSize } : {}),
        ...(gpuTimer?.maxResolveSkipStreak !== undefined
          ? { maxResolveSkipStreak: gpuTimer.maxResolveSkipStreak }
          : {}),
      },
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

  // WHERE THE FRAME ACTUALLY WENT, BEFORE ANY ZONE IS NAMED (2026-08-12). This
  // outranks `dominant-zone` deliberately: "geometry.worldDraw is 33% of frame
  // GPU" is only actionable once you know frame GPU is most of the frame. When
  // it is not, the biggest GPU zone is a distraction and this finding says so
  // first. See classifyBottleneck for why the residual is not called "CPU time".
  if (bottleneck && bottleneck.verdict !== 'unmeasured') {
    const notGpu = bottleneck.verdict === 'not-gpu-bound';
    out.push({
      severity: notGpu || bottleneck.tailDiffers ? 'high' : 'medium',
      id: 'bottleneck',
      text:
        `Median frame: ${bottleneck.median?.gpuMs}ms of timestamped render-pass GPU inside a ${bottleneck.median?.gapMs}ms frame ` +
        `(${pct((bottleneck.median?.gpuFraction ?? 0) * 100)}% explained, ${bottleneck.median?.unexplainedMs}ms not). ` +
        (bottleneck.tail
          ? `At p95: ${bottleneck.tail.gpuMs}ms inside ${bottleneck.tail.gapMs}ms (${pct(bottleneck.tail.gpuFraction * 100)}% explained, ${bottleneck.tail.unexplainedMs}ms not). `
          : '') +
        bottleneck.note,
      evidence: {
        verdict: bottleneck.verdict,
        medianGapMs: bottleneck.median?.gapMs ?? null,
        medianGpuMs: bottleneck.median?.gpuMs ?? null,
        medianUnexplainedMs: bottleneck.median?.unexplainedMs ?? null,
        tailVerdict: bottleneck.tail?.verdict ?? null,
        tailUnexplainedMs: bottleneck.tail?.unexplainedMs ?? null,
        tailDiffers: bottleneck.tailDiffers ?? false,
      },
    });
  }

  // DID THE PIPELINE TRADE PAY OFF? (2026-08-12). Ranked high because it is the
  // only finding in this report produced by an actual controlled experiment
  // rather than by reading one state — and because the question it settles
  // (Stage 1's early-Z prepass, ~18ms/frame) has been open, explicitly
  // "recommended next step, not buildable from this chair", since P-008.
  for (const t of structuralAB?.toggles ?? []) {
    if (t.verdict === 'unmeasured') {
      out.push({
        severity: 'medium',
        id: `structural-ab-unmeasured:${t.id}`,
        text: `The ${t.label} A/B ran but produced no comparable GPU numbers, so the trade is still unmeasured. ${t.note}`,
        evidence: { toggle: t.id },
      });
      continue;
    }
    const viewLocal = t.representative?.verdict === 'view-local';
    out.push({
      // 'within-noise' is not a null result to bury — it means the experiment
      // ran and could not decide, which is exactly when someone would otherwise
      // read the raw delta and believe it.
      severity: t.verdict === 'costs-more-than-it-saves' ? 'high' : t.verdict === 'within-noise' ? 'medium' : 'low',
      id: `structural-ab:${t.id}`,
      text:
        `${t.label} — ${t.note}` +
        (t.perZone?.length
          ? ` Biggest movers: ${t.perZone
              .slice(0, 3)
              .map((z) => `${z.id} ${z.deltaMs >= 0 ? '+' : ''}${z.deltaMs}ms`)
              .join(', ')}.`
          : '') +
        (t.representative?.note ? ` ${t.representative.note}` : '') +
        ` The question this answers: ${t.question}`,
      evidence: {
        toggle: t.id,
        verdict: t.verdict,
        liveState: t.liveState,
        onGpuMs: t.onGpuMs,
        offGpuMs: t.offGpuMs,
        deltaGpuMs: t.deltaGpuMs,
        noiseFloorMs: t.noiseFloorMs,
        representative: t.representative?.verdict ?? null,
        viewLocal,
        topMovers: (t.perZone ?? []).slice(0, 5),
      },
    });
  }

  // THE SAME GEOMETRY SUBMITTED TWICE (2026-08-12). Two zones reporting the same
  // draw-call AND triangle counts are drawing the same thing — which is
  // sometimes exactly right (a depth prepass IS a second submission of the same
  // meshes, and buys early-Z rejection with it) and sometimes a redundant pass
  // nobody noticed. This report cannot tell those apart and does not try.
  //
  // What it CAN do is stop the pair going unremarked. The 2026-08-12 capture had
  // `geometry.earlyZPrepass` and `geometry.depthDraw` both at exactly 9.1 draws
  // / 73,116.1 triangles, 18.1ms and 18.2ms respectively — 36ms/frame, over half
  // the GPU frame, spent submitting one set of meshes twice — and no finding
  // said a word about it. Whether that is the price of early-Z or a genuine
  // duplicate is the question this hands the reader, with the numbers already
  // lined up.
  {
    const drawn = (rows ?? []).filter(
      (r) =>
        !r.isPass && Number.isFinite(r.drawCalls) && r.drawCalls > 0 && Number.isFinite(r.triangles) && r.triangles > 0
    );
    const near = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.01;
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) {
        const a = drawn[i];
        const b = drawn[j];
        if (!near(a.drawCalls, b.drawCalls) || !near(a.triangles, b.triangles)) continue;
        const combined = ms((a.gpuMs?.amortisedMsPerFrame ?? 0) + (b.gpuMs?.amortisedMsPerFrame ?? 0));
        out.push({
          severity:
            combined > 0 && Number.isFinite(attribution?.frameGpuMs) && combined / attribution.frameGpuMs > 0.25
              ? 'high'
              : 'low',
          id: `duplicate-geometry:${a.id}+${b.id}`,
          text: `${a.id} and ${b.id} submit the SAME geometry — ${a.drawCalls} vs ${b.drawCalls} draw calls, ${a.triangles} vs ${b.triangles} triangles — costing ${combined}ms/frame between them. That is either a depth/early-Z prepass paying for itself in reduced overdraw downstream, or one submission too many. This report cannot tell which: it can see that the meshes went in twice, not what the second pass bought. Settle it with an A/B (structuralAB below, if this run has one) rather than by reasoning about it.`,
          evidence: {
            zones: [a.id, b.id],
            drawCalls: [a.drawCalls, b.drawCalls],
            triangles: [a.triangles, b.triangles],
            combinedGpuMs: combined,
          },
        });
      }
    }
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

  // ==========================================================================
  // RESIDENCY: IS THIS I/O LATENCY, OR SOMETHING ELSE WEARING ITS COAT?
  // ==========================================================================
  // Added 2026-08-12, and this one has a specific wrong answer it exists to
  // prevent, twice given.
  //
  // `residency.itemLoad` wraps a sequential `for...of` with `await
  // ensureItemLoaded(item)` inside. `ensureItemLoaded` has two branches: an
  // ALREADY-LOADED path with no `await` anywhere in it (a Map.get and a field
  // overwrite — genuinely sub-millisecond), and a NEW-ITEM path that pays real
  // network/IndexedDB round trips. Only the new-item path opens
  // `residency.itemLoadDims`/`residency.itemLoadMasks`, and the profiler emits
  // NO ROW AT ALL for a zone that never fired.
  //
  // So those two zones being absent is not a gap in the report — it is a
  // MEASUREMENT, and a decisive one: **zero new items appeared during this
  // window.** Every `ensureItemLoaded` call took the await-free fast path.
  //
  // Why that matters enough to hard-code: both the 2026-08-11 audit and the
  // Testament petition it corrected concluded residency is "a latency/
  // concurrency problem — overlap the sequential round trips", and proposed
  // parallelising those awaits as the single biggest lever. That conclusion is
  // sound ONLY for a window where the new-item path actually ran. On a window
  // where it did not, the same cost is coming from somewhere else entirely, and
  // parallelising I/O that never happened would buy exactly nothing. The
  // 2026-08-12 capture is that window — 6.19 SECONDS in `residency.itemLoad`
  // with both I/O children absent — and nothing in the report said so, because
  // an absent row looks the same as a row nobody thought about.
  {
    const byId = new Map((rows ?? []).map((r) => [r.id, r]));
    const load = byId.get('residency.itemLoad');
    const ioChildren = ['residency.itemLoadDims', 'residency.itemLoadMasks'];
    const fired = ioChildren.filter((id) => byId.has(id));
    const totalMs = load?.cpuMs?.totalMs ?? null;
    // Only interesting when the parent actually cost something. A window with no
    // residency activity at all is not a finding, it is a quiet scene.
    if (load && Number.isFinite(totalMs) && totalMs > 100) {
      if (fired.length === 0) {
        out.push({
          severity: 'high',
          id: 'residency-cost-is-not-io',
          text: `residency.itemLoad spent ${totalMs}ms (mean ${load.cpuMs.meanMs}ms over ${load.cpuMs.occurrences} occurrences, peak ${load.cpuMs.maxMs}ms) — but NEITHER of its I/O sub-zones (${ioChildren.join(', ')}) appears in this report at all. Those two only open on ensureItemLoaded's new-item path; the profiler emits no row for a zone that never fired. Their absence therefore MEASURES something rather than missing it: zero new items were loaded this window, so every call took the already-loaded branch, which contains no await at all. Whatever this time is, it is NOT the sequential network/IndexedDB latency that the 2026-08-11 residency audit identified and proposed parallelising — that path did not execute. Parallelising it would change nothing here. Look instead at what the pass does unconditionally per occurrence, independent of loading.`,
          evidence: {
            zone: 'residency.itemLoad',
            totalMs,
            meanMs: load.cpuMs.meanMs,
            maxMs: load.cpuMs.maxMs,
            occurrences: load.cpuMs.occurrences,
            ioZonesPresent: [],
            ioZonesExpected: ioChildren,
          },
        });
      } else {
        // The other half of the same question, and the reason this is not just a
        // one-sided alarm: when the I/O path DID run, say how much of the parent
        // it explains. A large unexplained remainder is the same finding as
        // above in weaker form; a small one confirms the audit's diagnosis.
        let childMs = 0;
        for (const id of fired) childMs += byId.get(id)?.cpuMs?.totalMs ?? 0;
        const explained = totalMs > 0 ? childMs / totalMs : null;
        out.push({
          severity: explained !== null && explained < 0.5 ? 'medium' : 'low',
          id: 'residency-io-share',
          text: `residency.itemLoad spent ${totalMs}ms, of which its real-I/O sub-zones (${fired.join(', ')}) account for ${ms(childMs)}ms — ${pct((explained ?? 0) * 100)}%. ${explained !== null && explained < 0.5 ? 'MOST OF THIS ZONE IS NOT I/O. The 2026-08-11 audit\'s "parallelise the sequential awaits" lever can only reach the I/O share; the majority here is something the pass does regardless of loading, and needs its own explanation.' : 'The majority of this zone IS genuine I/O wait, which is what the 2026-08-11 audit predicted — its concurrency fix targets the right thing on this window.'}`,
          evidence: {
            zone: 'residency.itemLoad',
            totalMs,
            ioMs: ms(childMs),
            ioFraction: round(explained, 3),
            ioZonesPresent: fired,
          },
        });
      }
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

  // CPU-ONLY EFFECTS ARE A REAL MEASUREMENT, NOT A GAP — but a reader scanning
  // effects[] for a verdict sees `declared.verdict:'unmeasured'` and nothing
  // else unless told to look at zoneCpuMs. 2026-08-05: the author caught this
  // report claiming these effects were invisible to it, when the zone profiler
  // (CPU+GPU per zone since specular-sync/vegetation-rank-stamp/wind-bake were
  // wired) had already measured them — the gap was legibility, not coverage.
  for (const e of effects ?? []) {
    if (e.method === 'cpu-zone-only' && Number.isFinite(e.zoneCpuMs)) {
      out.push({
        severity: 'low',
        id: `cpu-only-cost:${e.id}`,
        text: `${e.id}: ${e.zoneCpuMs}ms/frame CPU, no GPU zone and no resolved sweep reading. This effect has no draw-call GPU cost — its cost lives entirely on the CPU side, so declared.verdict reads 'unmeasured' by design, not by a hole in the instrument.`,
        evidence: { effect: e.id, zoneCpuMs: e.zoneCpuMs },
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

  // EFFECTS THAT NO RUN OF THIS TOOL CAN EVER PRICE (2026-08-12). An effect with
  // `zoneCoverage: 'partial'`/'none' draws inside somebody else's scene render
  // and has no bracket of its own, so zones can only ever report a fragment of
  // it. Its ONLY route to a number is the sweep — and the sweep diffs two
  // whole-frame medians, so on any run where its own noise floor exceeds the
  // effect's cost, that route is closed too.
  //
  // Both halves of that were already reported separately (`whyNotZoned` per
  // effect, `sweep-below-resolution` for the sweep) and the CONJUNCTION — "these
  // specific effects are unpriceable, permanently, until someone adds a zone" —
  // was left for the reader to assemble. It never got assembled: `water`,
  // `vegetation`, `fluid` and `grade` have gone unpriced in every capture to
  // date without that ever being stated as a standing gap rather than a
  // this-run absence.
  {
    const stranded = (effects ?? []).filter(
      (e) => e.enabled !== false && (e.zoneCoverage === 'partial' || e.zoneCoverage === 'none') && e.costMs === null
    );
    if (stranded.length > 0) {
      out.push({
        severity: 'medium',
        id: 'effects-unpriceable',
        text: `${stranded.length} enabled effect(s) have NO cost figure and cannot get one from this tool as it stands: ${stranded.map((e) => e.id).join(', ')}. Each draws inside a shared scene render with no bracket of its own (see effects[].whyNotZoned), so zones can only ever report a fragment; and the sweep — their only other route — could not resolve them either. This is a STANDING GAP in the instrument, not a property of this run: re-running will not fix it. The fix is a zone bracket around each one's draw, or accepting that these effects are permanently unbudgeted.`,
        evidence: {
          effects: stranded.map((e) => ({ id: e.id, zoneCoverage: e.zoneCoverage, why: e.whyNotZoned })),
        },
      });
    }
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

  // WHAT WAS RUNNING WHEN IT FROZE (2026-08-12). The 2026-08-11 residency audit
  // closed §5 with a named, unresolved mystery — 20 hitches of 250-667ms whose
  // decode/cache stats showed zero I/O — and the honest note that settling it
  // "needs a live Chrome trace correlated against hitchLog timestamps and
  // residency in-flight windows". The profiler now computes that correlation
  // itself, so the answer arrives with every report instead of needing a trace.
  //
  // BOTH ANSWERS ARE WORTH REPORTING. A high overlap is the first real evidence
  // pointing at residency; a ZERO overlap rules it out and redirects the next
  // investigation, which is exactly what the audit could not establish.
  {
    const hz = frame?.inFlightDuringHitches ?? null;
    const hitchFrames = hz?.frames ?? 0;
    if (hz && hitchFrames > 0) {
      const ranked = Object.entries(hz.zones ?? {}).sort((a, b) => b[1] - a[1]);
      if (ranked.length === 0) {
        out.push({
          severity: 'medium',
          id: 'hitches-no-zone-in-flight',
          text: `${hitchFrames} frame(s) exceeded ${hz.thresholdMs}ms, and NOT ONE of them had any profiler zone still open when it landed. Zones that span frames — the async residency brackets — are the only ones this check can catch, so this RULES OUT "a residency pass was mid-flight" as the explanation for the stalls in this window. That is a real result, not a missing measurement: it closes the hypothesis the 2026-08-11 audit left open and points the next investigation at something outside the instrumented render path entirely (GC, browser compositing, driver, or work nobody has bracketed yet).`,
          evidence: { hitchFrames, thresholdMs: hz.thresholdMs, zonesInFlight: [] },
        });
      } else {
        const [topId, topCount] = ranked[0];
        const share = pct((topCount / hitchFrames) * 100);
        out.push({
          severity: share >= 50 ? 'high' : 'medium',
          id: 'hitches-overlap-zone',
          text: `${topCount} of ${hitchFrames} frames over ${hz.thresholdMs}ms (${share}%) landed while ${topId} was still open. Only frame-spanning zones can appear here, so this is direct evidence about the question the 2026-08-11 residency audit closed unable to answer. ⚠️ OVERLAP IS NOT CAUSE: an async bracket that stays open across many frames will overlap hitches by coincidence alone. Compare this share against that zone's own occurrence rate — if the zone is open during 90% of ALL frames, overlapping 90% of hitches means nothing; if it is open during 20% of frames but 80% of hitches, that is a real signal.`,
          evidence: {
            hitchFrames,
            thresholdMs: hz.thresholdMs,
            zonesInFlight: ranked.map(([id, count]) => ({
              id,
              hitchFrames: count,
              share: pct((count / hitchFrames) * 100),
            })),
          },
        });
      }
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
    `An effect with method:'cpu-zone-only' (e.g. specular sync, vegetation rank-stamp, wind bake) has a real, measured cost — read effects[].zoneCpuMs. It has no draw-call GPU cost by nature, so declared.verdict reads 'unmeasured' by design, not because the run failed to see it.`,
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
  structuralAB = null,
  manifests = [],
  enabledEffects = null,
  vram = null,
  budgetMs = null,
  verbosity = 'default',
  profilerAnomalies = null,
  gpuTimer = null,
  pipelineStats = null,
  depthProxyPoolStats = null,
  shaderRebuildStats = null,
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
      // ⚠️ THREE DIFFERENT NUMBERS, AND CONFLATING THEM HID A REAL LOSS
      // (2026-08-12). `count` is how many hitches this report RECEIVED, which is
      // NOT how many happened: the viewer's own ring caps at HITCH_LOG_MAX and
      // shifts the oldest out. `droppedByRing` is how many it threw away before
      // this report ever saw them; `droppedFromReport` is how many were received
      // and merely not printed. Until now the first was unmeasured (nothing
      // produced `hitchesDropped`, so `?? 0` quietly asserted none) and the two
      // were summed into one `dropped` — so a run that lost 430 hitches to the
      // ring reported `dropped: 180`, all of it the harmless display cap.
      //
      // `null`, not 0, when the viewer cannot report it. "We do not know how
      // many were dropped" and "none were dropped" are different claims, and
      // frame.hangs.totalStalls (from the profiler's own complete gap ring) is
      // the honest total to compare `count` against.
      count: hitchItems.length,
      countIsReceivedNotTotal:
        "How many hitch records reached this report. Compare against frame.hangs.totalStalls — which comes from the profiler's own complete gap series — for how many actually occurred.",
      kept: Math.min(hitchCap, hitchItems.length),
      droppedFromReport: Math.max(0, hitchItems.length - hitchCap),
      droppedByRing: Number.isFinite(frame.hitchesDropped) ? frame.hitchesDropped : null,
      items: [...hitchItems].sort((a, b) => (b.gapMs ?? 0) - (a.gapMs ?? 0)).slice(0, hitchCap),
    },
    inFlightDuringHitches: frame.hitchZones ?? null,
  };

  const sweepMeasuredCount = effects.filter((e) => e.sweepMarginalGpuMs !== null).length;
  // ⚠️ MUST PASS THE MEASURED FLOOR (fixed 2026-08-12). `attributeZonesToEffects`
  // computes this same floor WITH `sweep.summary.noiseFloorMs` (the sweep's own
  // directly-measured open-vs-close baseline drift) and uses it to accept or
  // reject every per-effect reading. This call omitted it, so the floor printed
  // in `method.sweepNoiseFloorMs` and quoted in the `sweep-below-resolution`
  // finding could be SMALLER than the one the rejections were actually made
  // with — a report explaining its own rejections with the wrong threshold.
  // perf-lab.js's header records this exact class of bug (two disagreeing floors
  // in one report) as already found and fixed once; this was the same bug
  // surviving in a second call site.
  const sweepNoiseFloorMs = estimateSweepNoiseFloor(
    sweep?.summary?.perEffect ?? sweep?.perEffect ?? [],
    sweep?.summary?.noiseFloorMs ?? null
  );
  const sweepRejectedCount = effects.filter((e) => e.sweepUnresolvable !== null).length;
  const bottleneck = classifyBottleneck({ gapMs: frameBlock.gapMs, gpuMs: frameBlock.gpuMs });
  const findings = deriveFindings({
    attribution,
    rows: allRows,
    effects,
    frame: frameBlock,
    method,
    budgetMs,
    bottleneck,
    structuralAB,
    profilerAnomalies,
    gpuTimer,
    pipelineStats,
    depthProxyPoolStats,
    shaderRebuildStats,
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
    // WHERE THE FRAME WENT, as a verdict rather than as two numbers the reader
    // is told to divide. Sits beside `attribution` on purpose: attribution
    // partitions the GPU time we CAN see, this one says how much of the frame
    // that time is in the first place. A trustworthy partition of a third of the
    // frame is still only a third of the answer.
    bottleneck,
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
    // THE RAW SWEEP, ECHOED BACK VERBATIM (2026-08-06) — everything above this
    // point CONSUMES `sweep` (attributeZonesToEffects, estimateSweepNoiseFloor)
    // and reshapes it into the zone-oriented `effects[]`/`findings` shape; that
    // reshaping loses the sweep's OWN per-effect table (baseline/noise-floor/
    // resolved/suspiciousNegative/pctOfEffects — see perf-lab.js#summarizeSweep)
    // that its own renderer needs to draw the same table a standalone sweep
    // shows. Echoing it back lets a caller (boot.js's combined report action)
    // feed perf-lab's existing, tested display straight from ONE run instead of
    // re-running the sweep a second time just to get its own shape back.
    sweepRaw: sweep,
    // THE CONTROLLED EXPERIMENT, kept whole (2026-08-12). Unlike sweepRaw this
    // is not echoed for a renderer's benefit — it is here because findings[]
    // reports only each toggle's verdict and top three movers, while the full
    // per-zone ON/OFF table is what someone deciding whether to KEEP a pipeline
    // choice actually needs to read.
    structuralAB,
    vram,
    // INSTRUMENT HEALTH, kept separate from the measurements on purpose. An
    // unbalanced bracket or an overflowed query pool is a fault in the tool, and
    // reading it as a property of the renderer would send someone hunting a bug
    // that is not there.
    instrument: {
      profilerAnomalies,
      gpuTimer,
      // PIPELINE HEALTH (2026-08-09) — renderer.info.memory, sampled once at
      // the start of the real measurement window (after settling) and once at
      // the end. `null` means the harness in use does not implement
      // readPipelineStats, not "zero pipelines exist" — see
      // getVtPanViewerPipelineStats's own header for why `programs` is the
      // field worth watching first.
      pipelineStats,
      // DEPTH-PROXY MATERIAL POOL HEALTH (2026-08-11) — renderer.info.memory's
      // OWN sibling for the depth-proxy pool specifically: lifetime
      // hits/misses/evictions, sampled at the same two points as
      // pipelineStats and for the same reason. `null` means the harness in
      // use does not implement readDepthProxyPoolStats, not "the pool did
      // nothing" — see depth-proxy-material-pool.js's own header.
      depthProxyPoolStats,
      // SHADER-REBUILD CHURN (2026-08-11) — three's OWN shader-graph cache,
      // watched directly rather than through any one pool's proxy for it (see
      // deriveFindings' own comment on `shader-rebuild-churn` for why a
      // pool-scoped check alone was not enough: it cannot see churn in code
      // that was never routed through that pool at all, which is exactly the
      // shape of the bug this closed). `null` means the harness in use does
      // not implement readShaderRebuildStats, not "no churn happened" — see
      // shader-rebuild-probe.js's own header.
      shaderRebuildStats,
      note:
        'These describe the INSTRUMENT, not the renderer. Non-zero unbalancedBrackets or poolOverflowed ' +
        'means some numbers above are missing or suspect — fix the instrument before drawing conclusions. ' +
        'pipelineStats.start vs .end: any growth in `programs` during a pan-only window means a pipeline is ' +
        'being recompiled that should already be cached — see findings[] for the threshold this crosses. ' +
        'depthProxyPoolStats.start vs .end: a low hit rate means the same class of rebuild is happening ' +
        'downstream of the depth-proxy pool specifically — see findings[]. shaderRebuildStats.labels: any ' +
        'materialChanged/nodesChanged above zero is a REPEAT rebuild this window, not a cold start — see ' +
        'findings[] for which label and which fix it implies.',
    },
    findings,
    interpretation: buildInterpretation({
      attribution,
      method: { ...method, cpuClockResolutionMs: method.cpuClockResolutionMs ?? null },
    }),
  };
}

/**
 * THE TIER-COMPARISON TABLE (2026-07-29, rewritten same day) — THE tool for
 * "where should optimisation effort go", across every performance tier at
 * once. Two defects in the first version, both found from the author's own
 * first real run, fixed here:
 *
 * 1. **~300KB, mostly duplication.** v1 nested five COMPLETE `buildPerfReport`
 *    blobs under `tiers` — every zone's static prose (`declared.note`,
 *    `whyNotZoned`, `interpretation`, `instrument.gpuTimer.note`…) repeated
 *    five times verbatim, every near-flat CPU tick zone shown five times,
 *    every hitch's near-identical `decodeStats`/`cacheStats` five times over.
 *    None of that serves COMPARISON. Deleted: this function no longer returns
 *    the full per-tier reports at all — the caller (boot.js) keeps them
 *    reachable via a plain console getter for the rare full-forensic need,
 *    never auto-included in what gets copied to the clipboard.
 *
 * 2. **The real cost of an effect can hide in a zone nobody owns, and v1's
 *    `perEffect` table could not see it.** THE finding that started this
 *    rewrite: candle flames' OWN zone (`light.drawCandleFlame`) read flat
 *    (~0.02ms) across every tier, while the actual candle-tier effect —
 *    fewer/more merged point lights as the profile changes — showed up as
 *    real, GROWING GPU cost in `light.drawPointLights`/`drawColoration`,
 *    zones with `ownerEffectId: null` that a per-effect-only table can never
 *    surface (Performance-Insights.md §5B/§5C already found this once, by
 *    hand, from a full report — this function now finds it automatically).
 *
 * THE FIX for (2): `ranked` is ONE list, sorted by peak GPU cost, mixing two
 * kinds of row —
 *   - **every registered effect** (`kind:'effect'`), cost from `zoneGpuMs`
 *     (falling back to `costMs`) — already a rollup of every zone THAT
 *     effect owns, so it is never double-counted against (b);
 *   - **every zone with real GPU cost and NO owner** (`kind:'zone'`,
 *     `ownerEffectId == null`, and not a `isPass` container — a pass is
 *     already the sum of its own children, which would double it).
 * A zone belonging to an effect is never listed a second time here — it is
 * already inside that effect's row. An effect that could not be measured in
 * any tier still gets a row (`measured:false`, sorted to the bottom) rather
 * than silently vanishing — a hidden effect reads as "cheap", which is
 * exactly the `feedback_instruments_must_not_lie` shape this project already
 * has a name for.
 *
 * Pure, and still deliberately dumb about MEANING: it does not decide
 * whether a difference matters (that is this file's own noise-floor/
 * agreement machinery, already computed PER REPORT before this ever sees
 * it) — it only ranks and lines the numbers up so a person's eye does the
 * comparing. Reads `report.frame.hangs.totalStalls` for hitch count rather
 * than searching `bands[]` by label text — the label is a caption on a
 * threshold this file itself picked (`>50ms`), and matching prose that could
 * be reworded is exactly the fragile-fixture failure this project keeps a
 * name for.
 *
 * `perTierHealth` is the trust check that replaces reading the full report:
 * frame count, attribution coverage/verdict and GPU sample count, so "was
 * this tier's measurement solid" is answerable without the thing being
 * measured against.
 *
 * @param {Array<{profile: string, report: object}>} tierResults - one entry
 *   per tier actually run. A tier that threw and produced no report should be
 *   OMITTED by the caller, not passed with `report: null` — this function has
 *   no way to tell "didn't run" from "ran and returned nothing" apart, and the
 *   caller already knows which one happened.
 * @returns {{
 *   frame: Record<string, {gpuMsP50: number|null, gpuMsP95: number|null, avgFps: number|null, p1LowFps: number|null, hitchCount: number|null}>,
 *   perTierHealth: Record<string, {frames: number|null, coverage: number|null, verdict: string|null, gpuSampleCount: number|null}>,
 *   ranked: Array<{id: string, label: string, kind: 'effect'|'zone', measured: boolean, maxGpuMs: number|null, byProfile: Record<string, number|null>}>
 * }}
 */
export function summarizeTierComparison(tierResults) {
  const list = Array.isArray(tierResults) ? tierResults : [];
  const frame = {};
  const perTierHealth = {};
  /** @type {Map<string, {id: string, label: string, kind: 'effect'|'zone', byProfile: Record<string, number|null>}>} */
  const rows = new Map();

  for (const entry of list) {
    const profile = entry?.profile;
    const report = entry?.report;
    if (typeof profile !== 'string' || !profile || !report || typeof report !== 'object') continue;

    frame[profile] = {
      gpuMsP50: numOrNull(report.frame?.gpuMs?.p50),
      gpuMsP95: numOrNull(report.frame?.gpuMs?.p95),
      avgFps: numOrNull(report.frame?.fps?.avgFps),
      p1LowFps: numOrNull(report.frame?.fps?.p1LowFps),
      hitchCount: numOrNull(report.frame?.hangs?.totalStalls),
    };

    perTierHealth[profile] = {
      frames: numOrNull(report.window?.frames),
      coverage: numOrNull(report.attribution?.coverage),
      verdict: typeof report.attribution?.verdict === 'string' ? report.attribution.verdict : null,
      gpuSampleCount: numOrNull(report.frame?.gpuMs?.sampleCount),
    };

    for (const e of Array.isArray(report.effects) ? report.effects : []) {
      if (!e || typeof e.id !== 'string') continue;
      const key = `effect:${e.id}`;
      if (!rows.has(key)) rows.set(key, { id: e.id, label: e.label ?? e.id, kind: 'effect', byProfile: {} });
      rows.get(key).byProfile[profile] = numOrNull(e.zoneGpuMs) ?? numOrNull(e.costMs);
    }

    for (const z of Array.isArray(report.zones) ? report.zones : []) {
      if (!z || typeof z.id !== 'string' || z.ownerEffectId || z.isPass) continue;
      const gpuMs = numOrNull(z.gpuMs?.amortisedMsPerFrame);
      if (gpuMs === null) continue; // no real GPU number here (CPU-only, or genuinely absent) — not a cost row
      const key = `zone:${z.id}`;
      if (!rows.has(key)) rows.set(key, { id: z.id, label: z.label ?? z.id, kind: 'zone', byProfile: {} });
      rows.get(key).byProfile[profile] = gpuMs;
    }
  }

  const ranked = [...rows.values()]
    .map((r) => {
      const values = Object.values(r.byProfile).filter((v) => v !== null);
      return { ...r, measured: values.length > 0, maxGpuMs: values.length ? Math.max(...values) : null };
    })
    // Biggest peak cost first — the whole point is "what should I optimise
    // first". Unmeasured rows (`maxGpuMs: null`) sort last, distinguishable
    // from "measured and merely cheap" via `measured`.
    .sort((a, b) => (b.maxGpuMs ?? -1) - (a.maxGpuMs ?? -1));

  return { frame, perTierHealth, ranked };
}

/** `v` if it is a finite number, else `null` — never `NaN`/`undefined` leaking into a report. */
function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Budget for a pass id, falling back to the strict default. */
export function budgetForPass(passId, budgets) {
  return budgets?.[passId] ?? DEFAULT_PASS_BUDGET_MS;
}

export { medianOf, percentileOf };
