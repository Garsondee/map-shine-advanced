/**
 * @fileoverview Presentation pacing analysis for Performance Recorder.
 * Separates intentional presentation_gate skips from unexpected holds/errors
 * and distinguishes present/skip state flips from visible present irregularity.
 *
 * @module core/diagnostics/performance-recorder-pacing
 */

/** Skip reasons that are intentional presentation pacing (not defects). */
export const INTENTIONAL_SKIP_REASONS = Object.freeze([
  'presentation_gate',
]);

/** Skip reasons that indicate a problem worth investigating. */
export const PROBLEM_SKIP_REASONS = Object.freeze([
  'strict_hold',
  'composer_error',
  'context_lost',
  'unknown',
]);

/**
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * @param {number[]} arr
 * @param {number} p - 0..1
 * @returns {number}
 */
function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Estimate browser rAF callback rate from tick record spacing.
 * @param {object[]} ticks
 * @returns {number}
 */
export function estimateRafHz(ticks) {
  const gaps = [];
  for (let i = 1; i < (ticks?.length ?? 0); i += 1) {
    const prev = ticks[i - 1];
    const cur = ticks[i];
    if (!prev || !cur) continue;
    const gap = Number(cur.tMs) - Number(prev.tMs);
    if (gap > 5 && gap < 50) gaps.push(gap);
  }
  if (gaps.length < 8) return 60;
  const p50 = percentile(gaps, 0.5);
  return p50 > 0 ? round2(1000 / p50) : 60;
}

/**
 * @param {object} skipReasons
 * @param {number} totalTicks
 * @returns {object}
 */
function summarizeSkipReasons(skipReasons, totalTicks) {
  const total = Math.max(1, totalTicks);
  /** @type {Record<string, { count: number, pct: number }>} */
  const byReason = {};
  let intentionalSkips = 0;
  let problemSkips = 0;

  for (const [reason, count] of Object.entries(skipReasons ?? {})) {
    const n = Number(count) || 0;
    if (n <= 0) continue;
    byReason[reason] = { count: n, pct: round2((n / total) * 100) };
    if (reason === 'none') continue;
    if (INTENTIONAL_SKIP_REASONS.includes(reason)) intentionalSkips += n;
    else if (PROBLEM_SKIP_REASONS.includes(reason)) problemSkips += n;
    else intentionalSkips += n;
  }

  const skippedTotal = Object.entries(byReason)
    .filter(([k]) => k !== 'none')
    .reduce((s, [, v]) => s + v.count, 0);

  return {
    byReason,
    skippedTotal,
    intentionalSkips,
    problemSkips,
    intentionalSkipPct: round2((intentionalSkips / total) * 100),
    problemSkipPct: round2((problemSkips / total) * 100),
  };
}

/**
 * @param {object[]} ticks
 * @returns {object}
 */
function summarizeTiers(ticks) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const t of ticks ?? []) {
    const tier = t?.tier ?? 'unknown';
    counts.set(tier, (counts.get(tier) || 0) + 1);
  }
  const total = Math.max(1, ticks?.length ?? 0);
  /** @type {Record<string, number>} */
  const byTier = {};
  for (const [tier, n] of counts.entries()) {
    byTier[tier] = round2((n / total) * 100);
  }
  return byTier;
}

/**
 * @param {object[]} ticks
 * @returns {{ median: number, byFps: Record<string, number> }}
 */
function summarizeTargetFps(ticks) {
  const values = (ticks ?? [])
    .map((t) => Number(t?.targetFps) || 0)
    .filter((v) => v > 0);
  const median = values.length > 0 ? percentile(values, 0.5) : 0;
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  const total = Math.max(1, values.length);
  /** @type {Record<string, number>} */
  const byFps = {};
  for (const [fps, n] of counts.entries()) {
    byFps[String(fps)] = round2((n / total) * 100);
  }
  return { median: round2(median), byFps };
}

/**
 * Measure irregularity of spacing between *presented* compositor frames only.
 * @param {object[]} ticks
 * @returns {object|null}
 */
function analyzePresentSpacing(ticks) {
  const intervals = (ticks ?? [])
    .filter((t) => t?.presented === true)
    .map((t) => Number(t.sinceLastPresentMs) || 0)
    .filter((v) => v > 0);
  if (intervals.length < 4) return null;

  const p50 = percentile(intervals, 0.5);
  const p95 = percentile(intervals, 0.95);
  const avg = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  const targetInterval = p50 > 0 ? p50 : avg;
  const jitterRatio = targetInterval > 0 ? p95 / targetInterval : 1;

  return {
    p50Ms: round2(p50),
    p95Ms: round2(p95),
    avgMs: round2(avg),
    jitterRatio: round2(jitterRatio),
    irregular: jitterRatio > 1.35,
  };
}

/**
 * @typedef {'healthy_intentional_gating'|'irregular_present_spacing'|'unexpected_skips'|'mixed_tiers'|'insufficient_data'} PacingDiagnosis
 */

/**
 * Build pacing analysis for exports and insights.
 *
 * @param {object} params
 * @param {object[]} [params.ticks]
 * @param {object} [params.skipReasons]
 * @param {object} [params.pacing]
 * @param {number} [params.durationMs]
 * @param {object} [params.stutterSummary]
 * @returns {object}
 */
export function buildPacingAnalysis({
  ticks = [],
  skipReasons = {},
  pacing = {},
  durationMs = 0,
  stutterSummary = null,
}) {
  const tickTotal = Math.max(0, pacing?.ticksRecorded ?? ticks.length);
  if (tickTotal < 10) {
    return {
      diagnosis: 'insufficient_data',
      note: 'Record longer while exercising the scene to analyze presentation pacing.',
    };
  }

  const durationSec = Math.max(0.001, (Number(durationMs) || 0) / 1000);
  const rafHz = estimateRafHz(ticks);
  const targetFps = summarizeTargetFps(ticks);
  const tiers = summarizeTiers(ticks);
  const skip = summarizeSkipReasons(skipReasons, tickTotal);
  const presentSpacing = analyzePresentSpacing(ticks);

  const expectedSkipPct = targetFps.median > 0 && rafHz > 0
    ? round2(Math.max(0, (1 - targetFps.median / rafHz) * 100))
    : null;
  const actualSkipPct = round2(Number(pacing?.skippedPct) || 0);
  const skipDelta = (expectedSkipPct != null) ? round2(actualSkipPct - expectedSkipPct) : null;

  const presentSkipFlips = Number(pacing?.judderTransitions) || 0;
  const presentSkipFlipsPerSec = round2(presentSkipFlips / durationSec);

  // Healthy gating: most skips are presentation_gate and skip % is near theoretical.
  const gateShare = skip.byReason?.presentation_gate?.pct ?? 0;
  const gateDominates = gateShare >= 55;
  const skipNearExpected = skipDelta == null || Math.abs(skipDelta) <= 12;

  const presentGapCount = stutterSummary?.countsByKind?.present_gap ?? 0;
  const irregularPresents = presentSpacing?.irregular === true || presentGapCount > 0;

  const tierCount = Object.keys(tiers).filter((k) => k !== 'unknown' && (tiers[k] ?? 0) > 5).length;
  const mixedTiers = tierCount > 1;

  /** @type {PacingDiagnosis} */
  let diagnosis = 'healthy_intentional_gating';
  if (skip.problemSkipPct >= 3) diagnosis = 'unexpected_skips';
  else if (irregularPresents && !skipNearExpected) diagnosis = 'irregular_present_spacing';
  else if (mixedTiers && irregularPresents) diagnosis = 'mixed_tiers';
  else if (!gateDominates && skip.problemSkips > 0) diagnosis = 'unexpected_skips';
  else if (gateDominates && skipNearExpected) diagnosis = 'healthy_intentional_gating';

  let note = '';
  if (diagnosis === 'healthy_intentional_gating') {
    note = `~${actualSkipPct}% of rAF ticks skip the compositor by design (presentation_gate). `
      + `Target ~${targetFps.median || '?'} fps on ~${rafHz} Hz rAF → expected ~${expectedSkipPct ?? '?'}% skip. `
      + `Present/skip flips (${presentSkipFlipsPerSec}/s) are normal pacing cadence, not visible hitches.`;
  } else if (diagnosis === 'irregular_present_spacing') {
    note = 'Presented frames are arriving unevenly despite gating — check present_gap stutters and GPU/main-thread spikes.';
  } else if (diagnosis === 'unexpected_skips') {
    note = 'Non-gate skip reasons (strict_hold, errors) are elevated — inspect skipReasons breakdown.';
  } else if (diagnosis === 'mixed_tiers') {
    note = 'Presentation tier changed during capture — tier transitions can feel like judder even when gating is healthy.';
  }

  return {
    diagnosis,
    note,
    rafHz,
    targetFps,
    tiers,
    skip,
    expectedSkipPct,
    actualSkipPct,
    skipDelta,
    presentSpacing,
    presentSkipFlips,
    presentSkipFlipsPerSec,
    gateSharePct: gateShare,
    presentedPct: round2(Number(pacing?.presentedPct) || 0),
    presentedFpsApprox: round2((Number(pacing?.presentedPct) || 0) / 100 * rafHz),
  };
}
