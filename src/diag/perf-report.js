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
import { buildCacheRows, findLowHitRateCaches } from './cache-report.js';

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
/**
 * A steady/conditional zone's max must be at least this many times its own
 * mean before `steady-spike` fires — see that finding's own header for the
 * two live examples (6.8x, 30x) that motivated it. Picked, not derived: the
 * zero-allocation profiler tracks no variance/stddev to derive a real
 * statistical threshold from, so this is a hand-picked, documented multiple
 * in the same style as `DECLARED_OVER_FACTOR`/`AGREEMENT_TOLERANCE` above.
 */
export const STEADY_SPIKE_RATIO_FACTOR = 5;
/** Below this the spike itself is too small in absolute terms to matter, even at a wild ratio. */
export const STEADY_SPIKE_MIN_PEAK_MS = 5;
/**
 * report-density-2026-08-12 (author: "critique the report, too many tokens doesn't make things
 * easier"). A fullscreen post-process quad is EXACTLY 2 triangles / 1 draw call by construction
 * (QUAD_INDICES) — every bloom/DoF/present/composite pass matches every OTHER one on
 * drawCalls+triangles for that reason alone, not because anything is wrong. The 2026-08-12 live
 * capture's `duplicate-geometry` findings were 12 pairs, 11 of them exactly this shape (8,108 of
 * findings[]'s 26,457 bytes for zero new information — verified by hand against the real capture,
 * not guessed). Anything at or under this ceiling is folded into ONE summary finding instead of one
 * verbose finding per pair; real scene geometry (thousands of triangles) still gets its own full
 * finding, unchanged.
 */
export const TRIVIAL_GEOMETRY_TRIANGLE_CEILING = 8;

const round = (v, dp) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const ms = (v) => round(v, 3);
const pct = (v) => round(v, 1);

/**
 * Collapse repeated `decodeStats`/`cacheStats` blobs across a hitch list —
 * report-density-2026-08-12 (author: "too many tokens doesn't make things
 * easier for LLMs to work with"). Both are captured fresh AT EACH hitch's own
 * moment (vt-pan-viewer.js's own header: "full context AT THE MOMENT it
 * happened") — genuinely real per-hitch data, not a bug — but on a window
 * where nothing was actively streaming, EVERY hitch reads the identical
 * snapshot: the 2026-08-12 live capture had 20 hitches, 1 distinct
 * `decodeStats` value and 1 distinct `cacheStats` value between them — 13,129
 * of `frame`'s 16,282 bytes for information that says the same thing 20
 * times. Only a BYTE-IDENTICAL repeat is collapsed (a single differing field
 * is real information and stays in full) — the mechanism this exists to
 * preserve, unchanged: reading which hitch FIRST shows a changed value is
 * still exactly how a reader correlates a hitch with what streaming was
 * doing, per that same header's own worked example.
 * @param {object[]} items - already sorted/sliced to what the report will keep.
 */
export function dedupeHitchContext(items) {
  const seen = { decodeStats: new Map(), cacheStats: new Map() };
  return items.map((item, i) => {
    const out = { ...item };
    for (const key of ['decodeStats', 'cacheStats']) {
      const val = item[key];
      if (val === undefined || val === null) continue;
      const sig = JSON.stringify(val);
      const firstIndex = seen[key].get(sig);
      if (firstIndex === undefined) {
        seen[key].set(sig, i);
      } else {
        out[key] = `unchanged since items[${firstIndex}]`;
      }
    }
    return out;
  });
}

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

/**
 * FRONT-LOADED BURST vs STEADY TAX — the residency audit's own stated open
 * question ("is the mean a steady cost across all passes, or a few expensive
 * early passes dragging the average up?"), generalised to any zone with real
 * CPU cost, not just `residency.itemLoad`.
 *
 * A mean cannot answer this by construction: 10 occurrences at 10ms each and
 * 1 occurrence at 91ms plus 9 at 1ms both average to 10ms. `frame-profiler.js`
 * now tracks how much of a zone's total landed in the first `earlyWindowMs` of
 * the real (post-settle) window — this turns that split into a verdict.
 *
 * ⚠️ THE COMPARISON IS AGAINST WHAT UNIFORM WOULD LOOK LIKE, NOT AGAINST ZERO.
 * A zone that is genuinely steady still has SOME early share, just proportional
 * to how much of the window "early" covers — `earlyWindowMs / durationMs`. A
 * 10s early bucket in a 60s window should hold ~17% of a uniform zone's cost;
 * reporting anything less than 100% as suspicious would flag every healthy
 * zone. The verdict compares the ACTUAL early share against that EXPECTED
 * share, not against an arbitrary absolute threshold.
 */
export const TEMPORAL_RATIO_FACTOR = 1.5;
/** Below this total the split is measuring noise, not a real shape. */
export const TEMPORAL_MIN_TOTAL_MS = 50;

export function classifyTemporalShape({
  totalMs = null,
  earlyMs = null,
  earlyWindowMs = null,
  durationMs = null,
} = {}) {
  if (!Number.isFinite(totalMs) || totalMs < TEMPORAL_MIN_TOTAL_MS) {
    return {
      verdict: 'unmeasured',
      note: `Total cost under ${TEMPORAL_MIN_TOTAL_MS}ms — too small for the early/late split to say anything real.`,
    };
  }
  if (
    !Number.isFinite(durationMs) ||
    !Number.isFinite(earlyWindowMs) ||
    earlyWindowMs <= 0 ||
    durationMs <= earlyWindowMs
  ) {
    return {
      verdict: 'not-applicable',
      note:
        `The window (${ms(durationMs)}ms) is not longer than the early bucket (${ms(earlyWindowMs)}ms), so every ` +
        'sample in it is "early" by construction — the split cannot distinguish anything on a window this short.',
    };
  }
  const early = Number.isFinite(earlyMs) ? earlyMs : 0;
  const expectedEarlyFraction = earlyWindowMs / durationMs;
  const actualEarlyFraction = early / totalMs;
  const ratio = expectedEarlyFraction > 0 ? actualEarlyFraction / expectedEarlyFraction : null;
  const verdict =
    ratio === null
      ? 'unmeasured'
      : ratio >= TEMPORAL_RATIO_FACTOR
        ? 'front-loaded'
        : ratio <= 1 / TEMPORAL_RATIO_FACTOR
          ? 'back-loaded'
          : 'steady';
  return {
    verdict,
    earlyMs: ms(early),
    lateMs: ms(totalMs - early),
    totalMs: ms(totalMs),
    earlyWindowMs: ms(earlyWindowMs),
    durationMs: ms(durationMs),
    expectedEarlyFraction: round(expectedEarlyFraction, 3),
    actualEarlyFraction: round(actualEarlyFraction, 3),
    ratio: ratio === null ? null : round(ratio, 2),
    note: null,
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
      // The EARLY-only slice of the same cpu cost — perf-report.js's own
      // classifyTemporalShape reads this beside cpuMs to answer "is this a
      // steady tax or a front-loaded burst". GPU has no equivalent field: see
      // frame-profiler.js's header for why that split is CPU-only.
      cpuEarlyMs: statFrom(stat.cpuEarly, frames),
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
 * Law 11's row (docs/holy/UI-Testament.md §9, U6): "Steady-state panel cost
 * ≤ 0.3 ms... The UI's own cost is a row in the perf report — an instrument
 * that exempts itself is lying." `uiPerf` is `diag/ui-perf.js#getUiPerf
 * Snapshot()`'s own output, handed in as plain data — this file stays clock-
 * free per its own header, it never calls that module itself.
 *
 * Absent/unmeasured is its own real verdict, matching `compareToManifest`'s
 * vocabulary exactly rather than inventing a second one for the same idea —
 * a report built without wiring `uiPerf` in says so, it does not silently
 * omit the row or print a misleading 0ms.
 */
export function buildUiPerfSection(uiPerf) {
  if (!uiPerf || uiPerf.verdict === 'unmeasured' || !Number.isFinite(uiPerf.meanMs)) {
    return {
      count: uiPerf?.count ?? 0,
      meanMs: null,
      maxMs: null,
      budgetMs: uiPerf?.budgetMs ?? null,
      verdict: 'unmeasured',
      note: 'No Studio/Remote UI tick recorded this window — an instrument that exempts itself from measurement is lying (Law 11).',
    };
  }
  return {
    count: uiPerf.count,
    meanMs: uiPerf.meanMs,
    maxMs: uiPerf.maxMs,
    budgetMs: uiPerf.budgetMs,
    verdict: uiPerf.verdict,
    note:
      uiPerf.verdict === 'over'
        ? `Studio/Remote steady-state cost measured ${uiPerf.meanMs}ms mean over ${uiPerf.count} ticks, above the ${uiPerf.budgetMs}ms Law 11 budget.`
        : null,
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
    // report-density-2026-08-12: this exact sentence used to repeat verbatim
    // for every partial/none-coverage effect (3x in the 2026-08-12 capture) —
    // `whyNotZoned` right below already carries the SPECIFIC mechanism, and
    // the standing-gap finding (`effects-unpriceable`) already says this once
    // for all of them together. Short pointer, not a third copy of the reasoning.
    if (declared.verdict === 'unmeasured' && incomplete && sweepGpu === null) {
      declared.note = `Not comparable this run — zone coverage is '${zoning.coverage}'. See whyNotZoned/effects-unpriceable.`;
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
  // For classifyTemporalShape — both null by default so a caller that omits
  // them (every fixture predating 2026-08-12) gets 'not-applicable' verdicts
  // and zero new findings, not a crash.
  earlyWindowMs = null,
  durationMs = null,
  profilerAnomalies,
  gpuTimer,
  pipelineStats = null,
  depthProxyPoolStats = null,
  shaderRebuildStats = null,
  pipelineRebuildStats = null,
  windowDiagnostics = null,
  sweepRequested = false,
  sweepMeasuredCount = 0,
  sweepNoiseFloorMs = null,
  sweepRejectedCount = 0,
  caches = [],
  geometryComposition = null,
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
  // UNIFORM-BUFFER GROWTH (2026-08-12; RESOLVED 2026-08-13) — P-008's own
  // "open lead, not investigated this round" (uniformBuffers 2,137 → 8,637,
  // 4.04×), repeated in five straight touring captures (up to 11.42× by
  // 2026-08-12 night) and never settled. This finding's own text used to
  // instruct the reader to "re-run a window with the camera parked so no new
  // content streams in" — that experiment ran live 2026-08-13
  // (uniform-buffer-parked-probe.mjs): settled at 357, then held EXACTLY 357
  // for 55+ seconds of parked, ambient-only render loop (candle flicker, fire
  // particles, per-frame uniform pushes — zero new residency). By this
  // finding's own stated criterion ("if the ratio holds with a static view,
  // it is per-frame allocation, not content") the question is answered:
  // content-driven, not a leak. A touring route WILL always show growth here
  // — that is new residency legitimately allocating materials, expected and
  // benign — so this no longer needs anyone's attention on an ordinary
  // capture. Downgraded to `low` and kept only as a tripwire: a ratio this
  // large on a window that was NOT touring new content (a parked
  // structuralAB block, or a route that revisits only already-loaded ground)
  // would be the real, still-worth-chasing signal the original P-008 lead
  // was actually looking for.
  if (Number.isFinite(pipelineStats?.start?.uniformBuffers) && Number.isFinite(pipelineStats?.end?.uniformBuffers)) {
    const from = pipelineStats.start.uniformBuffers;
    const to = pipelineStats.end.uniformBuffers;
    const ratio = from > 0 ? to / from : null;
    if (ratio !== null && ratio >= 2) {
      out.push({
        severity: 'low',
        id: 'uniform-buffers-grew',
        text: `renderer.info.memory.uniformBuffers grew ${round(ratio, 2)}× (${from} → ${to}) across the measurement window — expected and benign for a touring route: a live parked-camera test (2026-08-13) confirmed this count holds perfectly flat once settled when no new content streams in, so growth here just means new residency material allocation, not a leak. Only worth a second look if this ratio shows up on a window that was NOT touring new ground (a parked measurement, or a route that only revisits already-loaded content).`,
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

  // PIPELINE-REBUILD CHURN (2026-08-12) — one cache layer downstream of
  // shader-rebuild-churn just above: not "was the TSL node graph rebuilt"
  // but "did that graph's shader source need a brand-new GPU PIPELINE
  // OBJECT" (device.createRenderPipeline — a real, synchronous,
  // main-thread-blocking driver call, three.webgpu.js's Pipelines class). A
  // node graph can be perfectly cached — shaderRebuildStats reading a clean
  // 0-miss window — while THIS cache still misses, e.g. the same material
  // rendering into a different render target for the first time. See
  // pipeline-rebuild-probe.js's own header for the mechanism, including why
  // counting `.set()` calls directly (rather than diffing cache size) is
  // what makes this reliable: a genuine rebuild can release the render
  // object's previous pipeline in the same call that installs the new one,
  // netting `.size` to zero even though a real compile happened.
  //
  // Same "not hedged" reasoning as shader-rebuild-churn, applied by hand:
  // this probe's `misses` is a flat per-label count with no built-in
  // settle-vs-churn split, so only a label's SECOND-and-later miss counts —
  // its first is an expected cold compile, same as any other cache warming
  // up, never a one-time settle cost this deep into the measured window.
  if (pipelineRebuildStats?.installed === true && Array.isArray(pipelineRebuildStats.labels)) {
    const churning = pipelineRebuildStats.labels.filter((l) => l.misses > 1);
    if (churning.length > 0) {
      const worst = churning[0]; // the probe itself sorts worst-first
      out.push({
        severity: 'high',
        id: 'pipeline-rebuild-churn',
        text: `${worst.label} forced a brand-new GPU pipeline compile ${worst.misses - 1} time(s) beyond its first this window. device.createRenderPipeline is synchronous and main-thread-blocking, and this is a DIFFERENT cache from shader-rebuild-churn's node graph one — see pipeline-rebuild-probe.js's own header for why a miss here can happen even when that one reads clean. Likely cause: this render object's material/geometry/render-target combination changing shape between frames (e.g. a render-target or blend-state change), not the node graph itself — pooling/reusing the object rather than the material is the fix to try first.`,
        evidence: {
          label: worst.label,
          misses: worst.misses,
          otherChurningLabels: churning.length - 1,
        },
      });
    }
  }

  // WINDOW-SURFACE SCENE COMPOSITION (2026-08-12) — chasing a real,
  // still-open finding: `light.drawWindowLight` reports ~4 GPU draw calls
  // per `renderer.render()` call where the code — "ONE MESH, ADDITIVE",
  // `window-surface-subsystem.js`'s own header — predicts 1. Node-level
  // testing against the REAL vendored three.js already confirms the
  // subsystem's OWN construction is correct (exactly one mesh, two
  // triangles) — so if this ever fires, the anomaly is not in how the mesh
  // is built, and is worth chasing at the live-scene level instead.
  //
  // `windowDiagnostics` is one entry per floor that has ever synced
  // (`getWindowLightInfo()`'s own doc), each carrying `sceneChildCount` from
  // `getStatus()` — see that function's own header for exactly why this
  // exists. A floor that is currently VISIBLE (the only state whose draw
  // cost this session's zone numbers actually reflect) with anything other
  // than exactly one scene child is the anomaly worth naming.
  for (const floor of windowDiagnostics ?? []) {
    if (!floor?.visible) continue; // an invisible floor draws nothing — its composition is moot
    const count = floor.sceneChildCount;
    if (!Number.isFinite(count) || count === 1) continue;
    out.push({
      severity: 'medium',
      id: `window-surface-composition:${floor.floorIndex}`,
      text: `Window light's floor ${floor.floorIndex} is visible and drawing, but its own scene contains ${count} children, not the 1 (one mesh, one quad) the subsystem's own construction guarantees when tested directly. ${count === 0 ? 'Zero children on a VISIBLE floor is a contradiction — hasContent()/mesh.visible say there is something to draw, but nothing is actually in the scene to draw it. Check whether disposal ran without also hiding the mesh.' : `Extra scene member(s) present: ${JSON.stringify((floor.sceneChildren ?? []).map((c) => c.type))}.`} This is the live data point the drawCalls:4-per-occurrence question needed — read it against light.drawWindowLight's own drawCalls/triangles for this window.`,
      evidence: { floorIndex: floor.floorIndex, sceneChildCount: count, sceneChildren: floor.sceneChildren ?? null },
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
    // TRIVIAL (fullscreen-quad) MATCHES ARE COLLECTED, NOT REPORTED ONE-BY-ONE
    // (report-density-2026-08-12) — see TRIVIAL_GEOMETRY_TRIANGLE_CEILING's own
    // doc. Every pair's data still reaches the reader, in evidence[], just
    // folded into ONE finding instead of one verbose finding per pair.
    const trivialPairs = [];
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) {
        const a = drawn[i];
        const b = drawn[j];
        if (!near(a.drawCalls, b.drawCalls) || !near(a.triangles, b.triangles)) continue;
        const combined = ms((a.gpuMs?.amortisedMsPerFrame ?? 0) + (b.gpuMs?.amortisedMsPerFrame ?? 0));
        if (a.triangles <= TRIVIAL_GEOMETRY_TRIANGLE_CEILING && b.triangles <= TRIVIAL_GEOMETRY_TRIANGLE_CEILING) {
          trivialPairs.push({ zones: [a.id, b.id], drawCalls: [a.drawCalls, b.drawCalls], combinedGpuMs: combined });
          continue;
        }
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
    if (trivialPairs.length > 0) {
      out.push({
        severity: 'low',
        id: 'duplicate-geometry-fullscreen-quads',
        text: `${trivialPairs.length} pair(s) of zones submit matching tiny (≤${TRIVIAL_GEOMETRY_TRIANGLE_CEILING}-triangle) geometry — the shape every fullscreen post-process quad has by construction (bloom/DoF/present/composite each draw one 2-triangle quad), so this is expected, not a discovery. Listed in evidence for completeness; not worth chasing individually the way a real-geometry match (see any OTHER duplicate-geometry:* finding) is.`,
        evidence: { pairs: trivialPairs },
      });
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

  // WHAT'S ACTUALLY INSIDE geometry.worldDraw (2026-08-25) — that zone is one
  // `renderer.render()` call with no internal timing seam (see
  // `getGeometryComposition`'s own doc, vt-pan-viewer.js), so this cannot say
  // WHERE its GPU ms went. What it CAN say, from data that already exists and
  // was previously never surfaced: how much of the map's art is still paying
  // full fill rate because coverage meshing hasn't reached it yet, and how
  // much of the owned geometry runs the pricier vegetation shader instead of
  // the plain one. Two independent signals, reported together because they
  // answer the same question ("why is worldDraw this expensive") from two
  // different angles; either alone can fire without the other.
  const covSummary = geometryComposition?.coverageMeshSummary ?? null;
  if (covSummary) {
    const evaluatedTotal = covSummary.neverEvaluated + covSummary.meshed + covSummary.fullyDense;
    if (evaluatedTotal > 0 && covSummary.neverEvaluated > 0) {
      const neverPct = pct((covSummary.neverEvaluated / evaluatedTotal) * 100);
      out.push({
        severity: neverPct >= 25 ? 'medium' : 'low',
        id: 'coverage-mesh-never-evaluated',
        text: `${covSummary.neverEvaluated} of ${evaluatedTotal} whole-image tiles (${neverPct}%) have never received a coverage grid — they are drawing an un-reduced quad/tessellation not because meshing found nothing to cut, but because the async grid fetch hasn't landed (or never resolved). In a steady-state capture this should be rare; a large count here means real content is paying full fill rate for a reason unrelated to how much of it is actually painted.`,
        evidence: {
          neverEvaluated: covSummary.neverEvaluated,
          evaluatedTotal,
          neverEvaluatedPct: neverPct,
          meshed: covSummary.meshed,
          fullyDense: covSummary.fullyDense,
        },
      });
    }
    if (
      covSummary.meshed > 0 &&
      Number.isFinite(covSummary.rasterizedFractionPct) &&
      covSummary.rasterizedFractionPct >= 60
    ) {
      out.push({
        severity: 'low',
        id: 'coverage-mesh-low-yield',
        text: `Coverage meshing is reaching this content (${covSummary.meshed} tile(s) evaluated) but only cutting it down to ${covSummary.rasterizedFractionPct}% of cells kept — this map's art may simply be dense enough that there is little empty canvas left to drop, unlike the mansion map the feature was originally tuned against.`,
        evidence: {
          meshed: covSummary.meshed,
          cellsTotal: covSummary.cellsTotal,
          cellsKept: covSummary.cellsKept,
          rasterizedFractionPct: covSummary.rasterizedFractionPct,
        },
      });
    }
    const materialTotal = covSummary.plainTriangles + covSummary.vegetationTriangles;
    if (materialTotal > 0 && covSummary.vegetationTriangles > 0) {
      const vegPct = pct((covSummary.vegetationTriangles / materialTotal) * 100);
      if (vegPct >= 20) {
        out.push({
          severity: vegPct >= 50 ? 'medium' : 'low',
          id: 'geometry-vegetation-material-share',
          text: `${vegPct}% of geometry.worldDraw's owned triangles (${covSummary.vegetationTriangles} of ${materialTotal}) run the pricier curl-noise + wind-sampled vegetation material rather than the plain whole-image one. Triangle share is not GPU-time share, but a prior investigation independently measured a single vegetation-tessellated item at up to 97% of this zone's cost on its own — worth checking directly if this map's dominant cost traces back to vegetation content rather than plain background/tile/foreground art.`,
          evidence: {
            vegetationTriangles: covSummary.vegetationTriangles,
            plainTriangles: covSummary.plainTriangles,
            vegetationTrianglePct: vegPct,
          },
        });
      }
    }
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
  // A STEADY ZONE WITH A CATASTROPHIC OUTLIER — the mean hides it completely
  // ==========================================================================
  // `sparse-spike` above already catches "cheap on average, brutal on the one
  // frame it lands" for bake/event zones — but `isSparseCadence` deliberately
  // EXCLUDES steady/conditional zones from that check, because their mean
  // already belongs in the per-frame budget by design (that's what makes them
  // steady). Nothing was watching whether a zone that runs every single frame
  // could ALSO have a wild outlier hiding behind a perfectly healthy-looking
  // mean — until this was found live, 2026-08-12: `pass.light.accumulate`
  // read 4.8ms mean / 32.7ms max (6.8x) and `light.pointLightUpdate` read
  // 0.76ms mean / 22.7ms max (30x) in the SAME capture, and neither crossed
  // any existing finding's threshold, because `dominant-zone`/`bottleneck`
  // only ever look at the mean and `sparse-spike` only ever looks at sparse
  // zones.
  //
  // ⚠️ THIS FINDING NAMES A SHAPE, NOT A CAUSE. A wide mean/max spread on a
  // steady zone is consistent with several real mechanisms — a shader or GPU
  // pipeline rebuild (check `shaderRebuildStats`/any `shader-rebuild-churn` or
  // `pipeline-rebuild-churn` finding FIRST if either fired this window — that
  // is a much more specific answer than this one), a one-time cache-warm cost
  // that happened to land inside the measured window, OS scheduling jitter,
  // or a genuine per-occurrence workload difference (more visible lights this
  // particular frame, more draw calls). What this finding hands you is WHICH
  // zone and HOW BIG the gap is — it cannot, from mean/max alone, say which
  // of those explains it.
  for (const r of (rows ?? []).filter((x) => !x.sparse)) {
    const spikes = [];
    // A PASS ROW'S gpuMs IS A DIFFERENT QUANTITY, NOT EXCLUDED ENTIRELY. Its
    // own header (annotatePassResiduals) is explicit: under exclusive GPU
    // attribution, a pass row's plain `gpuMs` is its UN-BRACKETED RESIDUAL —
    // whatever no sub-zone claimed — not the pass's total cost (that is
    // `totalGpuMs`). Checking the residual for a "spike" would answer a
    // different, mostly uninteresting question. Its `cpuMs`, though, is a
    // perfectly ordinary inclusive wall-time measurement with no such
    // caveat — and skipping the WHOLE row (the first cut of this finding
    // did exactly that) would have missed `pass.light.accumulate` itself,
    // the zone that motivated this finding in the first place.
    const columns = r.isPass
      ? [['cpuMs', 'CPU']]
      : [
          ['cpuMs', 'CPU'],
          ['gpuMs', 'GPU'],
        ];
    for (const [field, label] of columns) {
      const stat = r[field];
      if (!stat || !Number.isFinite(stat.meanMs) || !Number.isFinite(stat.maxMs) || stat.meanMs <= 0) continue;
      const ratio = stat.maxMs / stat.meanMs;
      if (stat.maxMs >= STEADY_SPIKE_MIN_PEAK_MS && ratio >= STEADY_SPIKE_RATIO_FACTOR) {
        spikes.push({ column: label, meanMs: stat.meanMs, maxMs: stat.maxMs, ratio: round(ratio, 1) });
      }
    }
    if (spikes.length === 0) continue;
    const worstRatio = Math.max(...spikes.map((s) => s.ratio));
    out.push({
      severity: worstRatio >= 15 ? 'high' : 'medium',
      id: `steady-spike:${r.id}`,
      text: `${r.id} runs every frame and looks cheap on average (${spikes.map((s) => `${s.meanMs}ms ${s.column} mean`).join(', ')}) — but peaked at ${spikes.map((s) => `${s.maxMs}ms ${s.column} (${s.ratio}x its own mean)`).join(', ')} at least once in this window. A per-frame mean this healthy hides a spike this size completely; as a one-frame stall it is a visible hitch that the frame budget alone would never predict.`,
      evidence: { zone: r.id, spikes },
    });
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

  // ==========================================================================
  // FRONT-LOADED BURST vs STEADY TAX, EVERY ZONE (2026-08-12)
  // ==========================================================================
  // Generalises the residency-specific check above: does THIS zone's cost look
  // like a uniform per-frame tax, or is it concentrated near the start of the
  // window (settling, cache warm-up, a one-time setup) or growing toward the
  // end (thermal throttling, a data structure that grows with session length,
  // degrading cache behaviour)? See classifyTemporalShape's own header for why
  // the comparison is against the EXPECTED early share for a uniform zone, not
  // against zero.
  //
  // Scanned for every row with real cpu cost, not a hand-picked list — the
  // MIN_TOTAL_MS/RATIO_FACTOR thresholds inside classifyTemporalShape are what
  // keep this from spamming a finding for every trivial zone, the same shape
  // duplicate-geometry and uniform-buffers-grew already use.
  for (const r of rows ?? []) {
    const shape = classifyTemporalShape({
      totalMs: r.cpuMs?.totalMs ?? null,
      earlyMs: r.cpuEarlyMs?.totalMs ?? 0,
      earlyWindowMs,
      durationMs,
    });
    if (shape.verdict !== 'front-loaded' && shape.verdict !== 'back-loaded') continue;
    const frontLoaded = shape.verdict === 'front-loaded';
    out.push({
      severity: 'medium',
      id: `temporal-shape:${r.id}`,
      text:
        `${r.id}: ${pct(shape.actualEarlyFraction * 100)}% of its ${shape.totalMs}ms total CPU cost landed in the ` +
        `first ${shape.earlyWindowMs}ms of the ${shape.durationMs}ms window, where a uniform/steady-rate zone would ` +
        `show ~${pct(shape.expectedEarlyFraction * 100)}% (${shape.ratio}x expected). ` +
        (frontLoaded
          ? 'FRONT-LOADED: this reads as a burst — new content settling in, a cache warming, a one-time setup cost — not a per-frame tax. Averaging it over the whole window UNDERSTATES what it costs early and OVERSTATES what it costs later; read earlyMs/lateMs below separately, never the blended mean.'
          : 'BACK-LOADED: this zone got MORE expensive as the window went on. Worth checking for thermal throttling, a growing data structure, or degrading cache behaviour — none of which a flat mean over the whole window would ever surface.'),
      evidence: {
        zone: r.id,
        verdict: shape.verdict,
        earlyMs: shape.earlyMs,
        lateMs: shape.lateMs,
        totalMs: shape.totalMs,
        earlyWindowMs: shape.earlyWindowMs,
        durationMs: shape.durationMs,
        expectedEarlyFraction: shape.expectedEarlyFraction,
        actualEarlyFraction: shape.actualEarlyFraction,
        ratio: shape.ratio,
      },
    });
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
    } else if (e.declared?.verdict === 'under') {
      // report-density-2026-08-12: computed by compareToManifest since day
      // one, never surfaced here — a reader following findings[] top-down
      // (this report's own stated reading order) had to manually scan all
      // 15 effects[] entries by hand to learn a manifest had gone stale on
      // the CHEAP side. LOW, deliberately: cheap to leave exactly as it is,
      // this is "the budgeting doc is pessimistic," never a problem.
      out.push({
        severity: 'low',
        id: `declared-cost-overstated:${e.id}`,
        text: `${e.id}: ${e.declared.note}`,
        evidence: {
          effect: e.id,
          measuredMsPerMp: e.measuredMsPerMp,
          declaredMinMsPerMp: e.declared.declaredMinMsPerMp,
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

  // CACHE HEALTH (2026-08-12) — the generalised form of depth-proxy-pool-
  // health, applied to every cache this report can see (see cache-report.js's
  // own header for why this is a blunt, single-threshold check rather than a
  // per-cache-tuned one). Ranked 'medium', matching depth-proxy-pool-health's
  // own severity for the same "hit rate under 50%" shape — real, but not
  // self-evidently a bug the way a shader-rebuild-churn finding is.
  for (const c of findLowHitRateCaches(caches)) {
    out.push({
      severity: 'medium',
      id: `cache-low-hit-rate:${c.id}`,
      text: `${c.label} hit rate is ${c.hitRatePct}% (${c.hits} hit${c.hits === 1 ? '' : 's'}, ${c.misses} miss${c.misses === 1 ? '' : 'es'}) during this window. A cache reused far less than it was rebuilt during ordinary panning suggests its invalidation key is changing more often than the content actually does — check what's flipping it every pass rather than assuming this is routine churn.`,
      evidence: { cache: c.id, hitRatePct: c.hitRatePct, hits: c.hits, misses: c.misses },
    });
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

/**
 * THE SUMMARY (2026-08-12, author: "a non-technical user... say the problem
 * is related to 'candles'"). A ranked top-10 in plain language, plus
 * cache-health warnings, meant to be read FIRST and never require opening
 * zones[]/effects[]/findings[]/caches[] at all. Pure presentation over data
 * this file already computed — no new measurement, and every entry carries
 * its own `sourceIds` so a technical reader can still jump to the raw row.
 *
 * WHY EFFECTS AND ZONES ARE MERGED INTO ONE RANKED LIST, NOT TWO SEPARATE
 * ONES: an effect's own `costMs` already includes every zone it owns (see
 * `attributeZonesToEffects`), so a zone with `ownerEffectId` set is SKIPPED
 * here — including it too would double-count. Only NULL-owned zones (engine
 * work no single effect can claim) compete as their own entries.
 *
 * WHY SOME HIGH-SEVERITY FINDINGS ALSO COMPETE FOR A SLOT: a real cost can
 * hide behind a finding with no zone of its own to rank by — shader-rebuild
 * churn, two zones submitting the same geometry, an overflowed GPU timestamp
 * pool. These would never appear in a summary built ONLY from zones[]/
 * effects[]'s own ms numbers, which is exactly the kind of gap this exists
 * to close.
 */
export function buildOffenderSummary({ rows, effects, findings, caches }) {
  const zoneById = new Map((rows ?? []).map((r) => [r.id, r]));
  const effectLabelById = new Map((effects ?? []).map((e) => [e.id, e.label]));
  /** A finding's evidence sometimes names a zone; if that zone belongs to an
   * effect, attribute the finding to the EFFECT's human label — this is the
   * literal "say it's the candles" mechanism the request named. */
  const labelForZoneId = (zoneId) => {
    const z = zoneById.get(zoneId);
    if (!z) return zoneId;
    if (z.ownerEffectId && effectLabelById.has(z.ownerEffectId)) return effectLabelById.get(z.ownerEffectId);
    return z.label ?? zoneId;
  };

  const candidates = [];

  for (const e of effects ?? []) {
    if (!Number.isFinite(e.costMs) || e.costMs <= 0) continue;
    const overBudget = e.declared?.verdict === 'over';
    candidates.push({
      label: e.label,
      costMs: e.costMs,
      severity: overBudget ? 'high' : 'info',
      whatItMeans: overBudget
        ? `${e.label} is costing ${e.costMs}ms every frame — ${e.declared.ratioToDeclaredMax}× its own declared budget. This has never been checked against a real measurement before now, so either the budget is stale or something regressed.`
        : `${e.label} is costing ${e.costMs}ms every frame.`,
      sourceIds: [e.id],
    });
  }

  for (const r of rows ?? []) {
    if (r.ownerEffectId || r.isPass || r.sparse) continue;
    const costMs = r.gpuMs?.amortisedMsPerFrame ?? r.cpuMs?.amortisedMsPerFrame ?? null;
    if (!Number.isFinite(costMs) || costMs <= 0) continue;
    candidates.push({
      label: r.label,
      costMs,
      severity: 'info',
      whatItMeans: `${r.label} — engine-level cost not owned by any single effect — is costing ${ms(costMs)}ms every frame.`,
      sourceIds: [r.id],
    });
  }

  // High-severity findings that name real cost with no zone/effect entry of
  // their own to be folded into above — see this function's own header.
  const COSTLY_FINDING_PREFIXES = [
    'duplicate-geometry:',
    'shader-rebuild-churn',
    'pipeline-rebuild-churn',
    'pipeline-programs-grew',
    'residency-cost-is-not-io',
    'declared-cost-understated:', // effects[] already carries this effect's OWN costMs — see the note below
  ];
  for (const f of findings ?? []) {
    if (f.severity !== 'high') continue;
    if (!COSTLY_FINDING_PREFIXES.some((p) => f.id.startsWith(p))) continue;
    // declared-cost-understated is already represented via its effect's own
    // candidate above (same costMs, same 'over' branch) — skip the duplicate
    // rather than let one real cost claim two ranked slots.
    if (f.id.startsWith('declared-cost-understated:')) continue;
    const impliedMs = f.evidence?.combinedGpuMs ?? null;
    const zones = f.evidence?.zones ?? (f.evidence?.zone ? [f.evidence.zone] : []);
    const label = zones.length ? zones.map(labelForZoneId).join(' + ') : f.id.split(':')[0].replace(/-/g, ' ');
    candidates.push({
      label,
      costMs: impliedMs,
      severity: 'high',
      whatItMeans: f.text,
      sourceIds: [f.id],
    });
  }

  // Instrument-health findings are WARNINGS about trusting the numbers
  // above, not offenders in their own right — kept in a separate list so
  // they never compete with (or get lost among) real cost entries.
  const INSTRUMENT_WARNING_PREFIXES = [
    'profiler-unbalanced-brackets',
    'timestamp-pool-overflow',
    'gpu-attribution-unavailable',
    'attribution-coverage-low',
    'sweep-produced-nothing',
  ];
  const instrumentWarnings = (findings ?? [])
    .filter((f) => INSTRUMENT_WARNING_PREFIXES.some((p) => f.id.startsWith(p)))
    .map((f) => ({ severity: f.severity, text: f.text }));

  // Cache warnings — plain-language restatement of cache-low-hit-rate,
  // never re-derived: same findLowHitRateCaches call deriveFindings already
  // made, so this can never disagree with findings[] about which caches
  // qualify.
  const cacheWarnings = findLowHitRateCaches(caches ?? []).map((c) => ({
    label: c.label,
    hitRatePct: c.hitRatePct,
    text: `${c.label} is only avoiding repeated work ${c.hitRatePct}% of the time this window (${c.misses} unnecessary rebuild${c.misses === 1 ? '' : 's'} out of ${c.hits + c.misses} checks) — worth a look before trusting it as healthy.`,
  }));

  // Real cost first (descending); high-severity findings with no ms number
  // rank just under the smallest measured cost rather than at the very top
  // (a known-real-but-unquantified issue should not outrank a huge measured
  // one) or the very bottom (it must not vanish below every trivial 0.01ms
  // zone either).
  const smallestRealCost = candidates.reduce(
    (min, c) => (Number.isFinite(c.costMs) && c.costMs < min ? c.costMs : min),
    Infinity
  );
  const rankValue = (c) =>
    Number.isFinite(c.costMs) ? c.costMs : (smallestRealCost === Infinity ? 1 : smallestRealCost) / 2;
  candidates.sort((a, b) => rankValue(b) - rankValue(a));

  const topOffenders = candidates.slice(0, 10).map((c, i) => ({
    rank: i + 1,
    label: c.label,
    costMs: Number.isFinite(c.costMs) ? ms(c.costMs) : null,
    severity: c.severity,
    whatItMeans: c.whatItMeans,
    sourceIds: c.sourceIds,
  }));

  return {
    note:
      topOffenders.length === 0
        ? 'Nothing measured a real cost or tripped a high-severity finding this run — either the scene is genuinely cheap, or attribution.verdict is poor enough that this list would be guessing. Check attribution.verdict before trusting an empty list as good news.'
        : `Ranked by measured ms/frame where a real number exists; high-severity findings with no zone of their own to rank by are folded in beneath the smallest measured cost, never above it and never dropped. Full detail for any entry: look up its sourceIds in effects[]/zones[]/findings[].`,
    topOffenders,
    cacheWarnings,
    instrumentWarnings,
  };
}

/**
 * Render `summary` (buildOffenderSummary's return value) as plain,
 * console-friendly text — "the displayed information after a run", not just
 * a field inside a JSON blob nobody opens. `boot.js`'s `perf-run-full` action
 * logs this directly, so the answer is on screen the moment the run finishes,
 * before anyone has to copy/paste/parse anything.
 * @param {ReturnType<typeof buildOffenderSummary>} summary
 * @returns {string}
 */
export function formatOffenderSummaryText(summary) {
  if (!summary) return 'No summary available.';
  const lines = ['🔬 PERFORMANCE SUMMARY', ''];
  if (summary.topOffenders.length === 0) {
    lines.push(`(nothing to rank) ${summary.note}`);
  } else {
    lines.push('Top performance issues, worst first:');
    for (const o of summary.topOffenders) {
      const costText = o.costMs !== null ? `${o.costMs}ms/frame` : '(no direct ms figure)';
      const flag = o.severity === 'high' ? ' ⚠️' : '';
      lines.push(`  ${o.rank}. ${o.label} — ${costText}${flag}`);
      lines.push(`     ${o.whatItMeans}`);
    }
  }
  lines.push('');
  if (summary.cacheWarnings.length === 0) {
    lines.push('Cache health: no cache is unhealthy this run.');
  } else {
    lines.push('⚠️ Cache warnings:');
    for (const w of summary.cacheWarnings) lines.push(`  - ${w.text}`);
  }
  if (summary.instrumentWarnings.length > 0) {
    lines.push('');
    lines.push('⚠️ Instrument warnings (numbers above may be affected):');
    for (const w of summary.instrumentWarnings) lines.push(`  - [${w.severity}] ${w.text}`);
  }
  return lines.join('\n');
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
    `caches[] is a DIFFERENT axis from zones[] — how well each cache is reusing work, not how much CPU/GPU time was spent. A low hitRatePct earns a cache-low-hit-rate finding; a null hitRatePct means that cache exposes no hits counter to compute one from (see each row's own note), not a healthy 0% read as absent.`,
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
  vramWindow = null,
  budgetMs = null,
  verbosity = 'default',
  profilerAnomalies = null,
  gpuTimer = null,
  pipelineStats = null,
  depthProxyPoolStats = null,
  cacheStats = null,
  shaderRebuildStats = null,
  pipelineRebuildStats = null,
  passSlotStats = null,
  windowDiagnostics = null,
  geometryComposition = null,
  uiPerf = null,
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
      // dedupeHitchContext skipped under verbosity:'full' — that mode's whole
      // contract (see `zonesCollapsed`'s own note) is "nothing collapsed".
      items: full
        ? [...hitchItems].sort((a, b) => (b.gapMs ?? 0) - (a.gapMs ?? 0)).slice(0, hitchCap)
        : dedupeHitchContext([...hitchItems].sort((a, b) => (b.gapMs ?? 0) - (a.gapMs ?? 0)).slice(0, hitchCap)),
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
  const caches = buildCacheRows({
    cacheStats,
    depthProxyPoolStats,
    shaderRebuildStats,
    pipelineRebuildStats,
    passSlotStats,
    windowDiagnostics,
  });
  const findings = deriveFindings({
    attribution,
    rows: allRows,
    effects,
    frame: frameBlock,
    method,
    budgetMs,
    bottleneck,
    structuralAB,
    earlyWindowMs: win.earlyWindowMs ?? null,
    durationMs: win.durationMs ?? null,
    profilerAnomalies,
    gpuTimer,
    pipelineStats,
    depthProxyPoolStats,
    shaderRebuildStats,
    pipelineRebuildStats,
    windowDiagnostics,
    sweepRequested: sweep !== null,
    sweepMeasuredCount,
    sweepNoiseFloorMs,
    sweepRejectedCount,
    caches,
    geometryComposition,
  });

  // STRIP cpuEarlyMs FROM EVERY ZONE THE temporal-shape FINDING DID NOT FLAG
  // (report-density-2026-08-12) — it is computed (findings[] above already
  // read it) but carried on every zone regardless of the verdict: the
  // 2026-08-12 live capture had it on 61 of 63 zones and it explained exactly
  // 1 finding. Kept in full under verbosity:'full'; kept on any zone that DID
  // earn a `temporal-shape:*` finding, since that is the one case where a
  // reader would want to see the early/late split with their own eyes rather
  // than trust the verdict alone. New objects, not mutation — `allRows` (what
  // `deriveFindings` above already read) is left untouched.
  const flaggedShapeZoneIds = new Set(
    findings.filter((f) => f.id.startsWith('temporal-shape:')).map((f) => f.evidence?.zone)
  );
  const trimmedZones = full
    ? kept
    : kept.map((r) => (r.cpuEarlyMs && !flaggedShapeZoneIds.has(r.id) ? { ...r, cpuEarlyMs: undefined } : r));

  const summary = buildOffenderSummary({ rows: allRows, effects, findings, caches });

  return {
    report: 'perf-profile',
    formatVersion: 1,
    // FIRST ON PURPOSE (2026-08-12) — the one thing meant to be read without
    // opening anything else. See buildOffenderSummary's own header.
    summary,
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
      // Echoed, not assumed — a reader looking at findings[]'s `temporal-
      // shape:*` evidence or a zone's own `cpuEarlyMs` must be able to see
      // exactly what "early" meant for THIS run without cross-referencing the
      // profiler's default.
      earlyWindowMs: win.earlyWindowMs ?? null,
      settleFramesDiscarded: win.settleFramesDiscarded ?? null,
      resolution: win.resolution ?? null,
      megapixels,
      sceneName: win.sceneName ?? null,
      floorIndex: win.floorIndex ?? null,
      loop: win.loop ?? 'viewer',
    },
    frame: frameBlock,
    // Law 11's row (docs/holy/UI-Testament.md §9, U6) — the Studio/Remote
    // UI's OWN steady-state cost, off the render-frame loop entirely
    // (`boot.js#pumpAstrolabe` is a separate rAF registration — see diag/
    // ui-perf.js's own header for why this is not a `zones` entry).
    uiPerf: buildUiPerfSection(uiPerf),
    // WHERE THE FRAME WENT, as a verdict rather than as two numbers the reader
    // is told to divide. Sits beside `attribution` on purpose: attribution
    // partitions the GPU time we CAN see, this one says how much of the frame
    // that time is in the first place. A trustworthy partition of a third of the
    // frame is still only a third of the answer.
    bottleneck,
    attribution,
    zones: trimmedZones,
    zonesCollapsed: collapsed,
    belowClockResolution: {
      note:
        "Mean is under the clock's own noise floor (resolution / sqrt(12n)). These zones RAN — they are " +
        'reported as present with no number, because a number here would be quantisation noise, which is the ' +
        'same lie as reporting 0 for "not measured".',
      ids: belowClock.map((r) => r.id),
    },
    effects,
    // EVERY CACHE THIS REPORT CAN SEE, one row each (2026-08-12) — see
    // cache-report.js's own header for the adapter that built this and why
    // three of these rows mirror instrument.* fields below rather than
    // owning a second copy of that data. `findings[]`'s own `cache-low-hit-
    // rate:*` entries are the generalised verdict on this same array.
    caches,
    // THE RAW SWEEP, ECHOED BACK VERBATIM (2026-08-06) — everything above this
    // point CONSUMES `sweep` (attributeZonesToEffects, estimateSweepNoiseFloor)
    // and reshapes it into the zone-oriented `effects[]`/`findings` shape; that
    // reshaping loses the sweep's OWN per-effect table (baseline/noise-floor/
    // resolved/suspiciousNegative/pctOfEffects — see perf-lab.js#summarizeSweep)
    // that its own renderer needs to draw the same table a standalone sweep
    // shows. Echoing it back lets a caller (boot.js's combined report action)
    // feed perf-lab's existing, tested display straight from ONE run instead of
    // re-running the sweep a second time just to get its own shape back.
    // WORLD-DRAW COMPOSITION (2026-08-12, Testament Track B.1) — what's
    // actually IN geometry.worldDraw's 13 draws / 266k triangles, grouped by
    // item kind. geometry.worldDraw itself (in zones[] above) is one opaque
    // renderer.render() call with no internal timing seam — this is the
    // cheaper, safe question this report CAN answer instead: composition, not
    // GPU time. `null` means the harness does not implement
    // readGeometryComposition, or the viewer had not started. See
    // getGeometryComposition's own doc (vt-pan-viewer.js) for the closed
    // item.kind list and the ownership-vs-paint-time caveat, which travels
    // with the data itself in its own `.note` field.
    geometryComposition,
    sweepRaw: sweep,
    // THE CONTROLLED EXPERIMENT, kept whole (2026-08-12). Unlike sweepRaw this
    // is not echoed for a renderer's benefit — it is here because findings[]
    // reports only each toggle's verdict and top three movers, while the full
    // per-zone ON/OFF table is what someone deciding whether to KEEP a pipeline
    // choice actually needs to read.
    structuralAB,
    vram,
    // PEAK-OVER-WINDOW, sibling to `vram` above, not a replacement for it
    // (2026-08-26) — `vram` is a single end-of-window snapshot; this is
    // sampled repeatedly across the whole armed window (settle included), so
    // a mid-capture spike a snapshot would never see (a fresh floor's
    // texture-upload burst, a residency-pass allocation storm) is visible
    // here as `vramWindow.peak`. `null` means the harness in use does not
    // implement `readVram`, exactly like `vram` itself. See
    // `diag/perf-session.js#createVramSampler` for the sampler.
    vramWindow,
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
      // PIPELINE-REBUILD CHURN (2026-08-12) — one cache layer downstream of
      // shaderRebuildStats above: watches three's GPU PIPELINE cache
      // (device.createRenderPipeline) directly, which can miss even when the
      // node-graph cache above reads clean — see pipeline-rebuild-probe.js's
      // own header. `null` means the harness in use does not implement
      // readPipelineRebuildStats, not "no churn happened".
      pipelineRebuildStats,
      // PASS-SLOT ALLOCATOR, RAW (cache-completeness pass, 2026-08-12) —
      // frame-profiler.js's own `{slots, declaredCount, passSlotsUsed}`,
      // already relative to this window (reset on every arm). `null` means
      // the harness does not implement readPassSlotStats. See
      // `framePassSlotAllocator` in caches[] for the normalized row, and
      // `profilerAnomalies.passSlotOverflow` for when this ran out of room.
      passSlotStats,
      // CACHE HEALTH, RAW (2026-08-12) — the keyed start/end snapshot pair
      // `caches[]` above was built from, echoed back verbatim for a reader
      // who wants a cache's own native shape (page-cache.js's
      // capacityPages/pinnedCoarse/etc., decode-pool's idb*/worker* fields)
      // rather than the normalized row. `null` means the harness does not
      // implement readCacheStats.
      cacheStats,
      // WINDOW-SURFACE COMPOSITION (2026-08-12) — one entry per floor that
      // has ever synced, each carrying `sceneChildCount`/`sceneChildren` from
      // `getStatus()`. `null` means the harness does not implement
      // readWindowDiagnostics; `[]` means the harness implements it but no
      // floor has synced yet — two different absences, neither a lie. See
      // `window-surface-composition` in findings[] for the question this
      // exists to answer.
      windowDiagnostics,
      note:
        'These describe the INSTRUMENT, not the renderer. Non-zero unbalancedBrackets or poolOverflowed ' +
        'means some numbers above are missing or suspect — fix the instrument before drawing conclusions. ' +
        'pipelineStats.start vs .end: any growth in `programs` during a pan-only window means a pipeline is ' +
        'being recompiled that should already be cached — see findings[] for the threshold this crosses. ' +
        'depthProxyPoolStats.start vs .end: a low hit rate means the same class of rebuild is happening ' +
        'downstream of the depth-proxy pool specifically — see findings[]. shaderRebuildStats.labels: any ' +
        'materialChanged/nodesChanged above zero is a REPEAT rebuild this window, not a cold start — see ' +
        'findings[] for which label and which fix it implies. pipelineRebuildStats.labels: a DIFFERENT, ' +
        'downstream cache from shaderRebuildStats — misses above 1 for a label is a repeat GPU pipeline ' +
        'compile, and can fire even when shaderRebuildStats reads clean.',
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

/**
 * THE FLOOR-WIDE STRUCTURAL-AB ROLLUP (2026-08-26) — "does Shade Once (or
 * point-light batching) actually help, floor by floor", the direct answer to
 * the author's own ask: *"You can include Shade Once pro and con tests for
 * every floor on a map."* Boot's own floor-sweep loop (see `boot.js`'s
 * floorStructuralAB phase) calls `runStructuralAB` once per floor and passes
 * the resulting `perFloor[]` array here — this function only ROLLS UP verdicts
 * already computed elsewhere, it makes no measurement decision of its own,
 * same "pure, deliberately dumb about meaning" posture as
 * `summarizeTierComparison` above.
 *
 * @param {Array<{floorIndex:number, structuralAB: {toggles: Array<{id:string, verdict:string}>}|null}>} perFloor
 * @returns {{byToggle: Record<string, {floorsWithVerdict: Record<string,string>, agreement: 'consistent'|'mixed'|'insufficient-data', note: string}>}}
 */
export function summarizeFloorStructuralAB(perFloor) {
  const floors = Array.isArray(perFloor) ? perFloor : [];
  /** @type {Map<string, Record<string, string>>} */
  const byToggleFloors = new Map();
  for (const f of floors) {
    const toggles = f?.structuralAB?.toggles;
    if (!Array.isArray(toggles)) continue;
    for (const t of toggles) {
      if (!t || typeof t.id !== 'string' || typeof t.verdict !== 'string') continue;
      if (!byToggleFloors.has(t.id)) byToggleFloors.set(t.id, {});
      byToggleFloors.get(t.id)[String(f.floorIndex)] = t.verdict;
    }
  }

  const byToggle = {};
  for (const [id, floorsWithVerdict] of byToggleFloors) {
    const verdicts = Object.values(floorsWithVerdict);
    // Only these two verdicts are DECISIVE — 'within-noise'/'unmeasured' mean
    // that floor could not tell, not that it agrees with "no effect".
    const decisive = verdicts.filter((v) => v === 'pays-for-itself' || v === 'costs-more-than-it-saves');
    const uniqueDecisive = new Set(decisive);
    let agreement;
    let note;
    if (verdicts.length === 0) {
      agreement = 'insufficient-data';
      note = 'No floor produced a verdict for this toggle.';
    } else if (decisive.length === 0) {
      agreement = 'insufficient-data';
      note = `Every floor that measured this toggle came back within-noise or unmeasured (${verdicts.length} floor(s)) — no floor could tell either way.`;
    } else if (uniqueDecisive.size === 1) {
      agreement = 'consistent';
      note = `Every floor that reached a verdict agreed: ${[...uniqueDecisive][0]} (${decisive.length} of ${verdicts.length} floor(s) decisive).`;
    } else {
      agreement = 'mixed';
      note =
        `Floors DISAGREE on this toggle — some say pays-for-itself, others say costs-more-than-it-saves ` +
        `(${decisive.length} of ${verdicts.length} floor(s) decisive). This is a real, reportable finding: the ` +
        `trade's value genuinely differs by floor, not an instrument fault.`;
    }
    byToggle[id] = { floorsWithVerdict, agreement, note };
  }
  return { byToggle };
}

/**
 * KNOWN, HAND-MAINTAINED GAPS in what the tier sweep (`runAllTiersPerfReport`)
 * can actually observe (2026-08-26). `forcePerformanceProfile()` — what the
 * sweep uses to flip tiers — is deliberately transient and never calls
 * `writeSetting`; a gate that reads the REAL persisted setting directly, at
 * material-build time, never sees the transient override and shows the same
 * material unchanged across every tier. Confirmed present for one real gate
 * by direct source read; whether any OTHER effect has a similarly-shaped gate
 * is UNVERIFIED — this is a hand-maintained list of confirmed cases, not a
 * closed/exhaustive one, the same "must be added here by hand or this report
 * goes silently dishonest about it again" discipline `structuralToggleHooks`'
 * own id-dispatch (boot.js) already carries for structural toggles.
 */
export const TIER_SWEEP_COVERAGE_CAVEATS = Object.freeze([
  Object.freeze({
    affects: 'albedoClarity',
    gate:
      'shouldUseFullAlbedoClarity() (vt-pan-viewer.js) — read once, at material-build time, during ' +
      "startVtPanViewer's own construction",
    why:
      'forcePerformanceProfile() (what this sweep uses to flip tiers) is deliberately transient and never calls ' +
      'writeSetting, and this gate reads the REAL persisted setting directly — so a transient profile override ' +
      'never reaches it. Every tier in this sweep shows the CAS/sharpening material completely unchanged. This ' +
      'is a real, structural instrument gap, not measurement noise. A bare viewer restart per tier would NOT ' +
      'fix this either — it would rebuild the material against whatever tier is genuinely SAVED, not the tier ' +
      'being swept, which is silently wrong in a new way, not fixed.',
    useInstead:
      'MapShine.setSharpeningAbEnabled(true), then re-run the performance report — that phase already does a ' +
      'real viewer restart with the diagnostic-only override (setVtPanViewerAlbedoClarityForce) built ' +
      'specifically to avoid this trap, for exactly this comparison.',
  }),
]);

/** `v` if it is a finite number, else `null` — never `NaN`/`undefined` leaking into a report. */
function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Budget for a pass id, falling back to the strict default. */
export function budgetForPass(passId, budgets) {
  return budgets?.[passId] ?? DEFAULT_PASS_BUDGET_MS;
}

export { medianOf, percentileOf };
