/**
 * @fileoverview Frame budget rollup for Performance Recorder exports.
 * Estimates per-frame GPU cost from sampled spans and diagnoses present-interval
 * mismatches (compositor CPU healthy but achieved FPS below target).
 *
 * @module core/diagnostics/performance-recorder-frame-budget
 */

/**
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * @param {object[]} effects
 * @param {'render'|'update'} phase
 * @returns {object[]}
 */
function topSpansByGpuAvg(effects, phase = 'render') {
  return (effects ?? [])
    .filter((row) => row.phase === phase && (Number(row.gpuAvg) || 0) > 0)
    .map((row) => ({
      effect: row.effect,
      phase: row.phase,
      gpuAvg: Number(row.gpuAvg) || 0,
      gpuMax: Number(row.gpuMax) || 0,
      cpuAvg: Number(row.cpuAvg) || 0,
      trianglesAvg: Number(row.trianglesAvg) || 0,
      gpuBlocked: Number(row.gpuBlocked) || 0,
    }))
    .sort((a, b) => b.gpuAvg - a.gpuAvg);
}

/**
 * @param {object[]} effects
 * @returns {number}
 */
function sumGpuBlockedSamples(effects) {
  let total = 0;
  for (const row of effects ?? []) {
    total += Number(row.gpuBlocked) || 0;
  }
  return total;
}

/**
 * Build frame-budget diagnostics for export JSON and insights.
 *
 * @param {object} params
 * @param {object[]} params.effects - Effect snapshot rows
 * @param {object} [params.session]
 * @param {object} [params.stutterSummary]
 * @param {object} [params.meta]
 * @returns {object|null}
 */
export function buildFrameBudgetSection({ effects, session, stutterSummary, meta }) {
  const renderSpans = topSpansByGpuAvg(effects, 'render');
  const sampledGpuAvgMs = renderSpans.reduce((sum, row) => sum + row.gpuAvg, 0);
  const compositorCpuAvgMs = Number(session?.frameTime?.avg) || 0;
  const compositorCpuP95Ms = Number(session?.frameTime?.p95) || 0;
  const achievedFpsAvg = Number(session?.fps?.avg) || 0;
  const presentP50Ms = Number(stutterSummary?.sinceLastPresentMs?.p50) || 0;
  const presentP95Ms = Number(stutterSummary?.sinceLastPresentMs?.p95) || 0;
  const rafGapP50Ms = Number(stutterSummary?.rafGapMs?.p50) || 0;

  const ctx = meta?.context ?? {};
  const targetFps = Number(ctx.targetFps) || 60;
  const targetIntervalMs = 1000 / Math.max(1, targetFps);
  const achievedPresentFps = presentP50Ms > 0 ? 1000 / presentP50Ms : 0;

  const gpuBlockedSamples = sumGpuBlockedSamples(effects);
  const note = 'Summed gpuAvg across render-phase spans is a lower bound — WebGL allows one active GPU query, '
    + 'so nested/blocked passes are under-reported. Compare sampledGpuAvgMs to present interval to spot GPU-bound pacing.';

  /** @type {string|null} */
  let primaryBottleneck = null;
  /** @type {string|null} */
  let diagnosis = null;

  if (renderSpans.length > 0) {
    primaryBottleneck = `${renderSpans[0].effect} (~${round2(renderSpans[0].gpuAvg)} ms GPU avg)`;
  }

  const compositorLooksHealthy = compositorCpuP95Ms > 0 && compositorCpuP95Ms < targetIntervalMs * 0.75;
  const presentSlowerThanTarget = presentP50Ms > targetIntervalMs * 1.35;
  const sampledGpuExceedsCpu = sampledGpuAvgMs > compositorCpuAvgMs * 1.25 && sampledGpuAvgMs > 4;

  if (compositorLooksHealthy && presentSlowerThanTarget) {
    if (sampledGpuExceedsCpu || sampledGpuAvgMs > targetIntervalMs * 0.5) {
      diagnosis = 'gpu_bound_presentation';
    } else {
      diagnosis = 'main_thread_or_browser_pacing';
    }
  } else if (compositorCpuP95Ms > targetIntervalMs) {
    diagnosis = 'compositor_cpu_bound';
  }

  return {
    note,
    targetFps,
    targetIntervalMs: round2(targetIntervalMs),
    compositorCpuAvgMs: round2(compositorCpuAvgMs),
    compositorCpuP95Ms: round2(compositorCpuP95Ms),
    sampledGpuAvgMs: round2(sampledGpuAvgMs),
    achievedFpsAvg: round2(achievedFpsAvg),
    achievedPresentFps: round2(achievedPresentFps),
    presentP50Ms: round2(presentP50Ms),
    presentP95Ms: round2(presentP95Ms),
    rafGapP50Ms: round2(rafGapP50Ms),
    gpuBlockedSamples,
    primaryBottleneck,
    diagnosis,
    topGpuRenderSpans: renderSpans.slice(0, 8).map((row) => ({
      effect: row.effect,
      gpuAvg: round2(row.gpuAvg),
      gpuMax: round2(row.gpuMax),
      cpuAvg: round2(row.cpuAvg),
      trianglesAvg: round2(row.trianglesAvg),
    })),
  };
}
