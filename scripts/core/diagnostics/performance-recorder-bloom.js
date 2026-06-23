/**
 * @fileoverview Bloom post-merge profiler helpers.
 *
 * @module core/diagnostics/performance-recorder-bloom
 */

/** Max detailed span rows in summary JSON exports. */
export const SUMMARY_BLOOM_SPANS_CAP = 28;

/**
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * @returns {import('../../compositor-v2/effects/BloomEffectV2.js').BloomEffectV2|null}
 */
export function resolveBloomEffect() {
  try {
    return window?.MapShine?.effectComposer?._floorCompositorV2?._bloomEffect
      ?? window?.MapShine?.floorCompositorV2?._bloomEffect
      ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} effect
 * @returns {boolean}
 */
function isBloomEffectKey(effect) {
  const key = String(effect ?? '');
  return key === 'bloom.postMerge'
    || key.startsWith('bloom.postMerge.')
    || key.startsWith('bloom.render.')
    || key.startsWith('bloom.update.');
}

/**
 * @param {object} row
 * @returns {number}
 */
function spanCost(row) {
  return (Number(row.cpuTotal) || 0) + (Number(row.gpuTotal) || 0);
}

/**
 * @param {object} row
 * @returns {object}
 */
function slimSpanRow(row) {
  /** @type {Record<string, unknown>} */
  const out = {
    span: row.span,
    phase: row.phase,
    cpuTotal: round2(row.cpuTotal),
    cpuAvg: round2(row.cpuAvg),
    cpuMax: round2(row.cpuMax),
    cpuCount: row.cpuCount ?? 0,
    gpuTotal: round2(row.gpuTotal),
    gpuAvg: round2(row.gpuAvg),
    gpuMax: round2(row.gpuMax),
    gpuCount: row.gpuCount ?? 0,
  };
  if ((row.drawCallsAvg ?? 0) > 0) out.drawCallsAvg = round2(row.drawCallsAvg);
  if ((row.trianglesAvg ?? 0) > 0) out.trianglesAvg = round2(row.trianglesAvg);
  if ((row.gpuBlocked ?? 0) > 0) out.gpuBlocked = row.gpuBlocked;
  return out;
}

/**
 * @param {object[]} effects
 * @param {{ cap?: number|null }} [options]
 * @returns {object[]}
 */
export function buildBloomSpanRows(effects, options = {}) {
  const cap = options.cap ?? null;
  const rows = [];
  for (const row of effects ?? []) {
    if (!isBloomEffectKey(row.effect)) continue;
    rows.push({
      span: row.effect,
      phase: row.phase,
      cpuLast: row.cpuLast,
      cpuAvg: row.cpuAvg,
      cpuMax: row.cpuMax,
      cpuTotal: row.cpuTotal,
      cpuCount: row.cpuCount,
      gpuLast: row.gpuLast,
      gpuAvg: row.gpuAvg,
      gpuMax: row.gpuMax,
      gpuTotal: row.gpuTotal,
      gpuCount: row.gpuCount,
      drawCallsAvg: row.drawCallsAvg,
      trianglesAvg: row.trianglesAvg,
      gpuBlocked: row.gpuBlocked,
    });
  }
  rows.sort((a, b) => spanCost(b) - spanCost(a));
  const limited = cap != null && cap > 0 ? rows.slice(0, cap) : rows;
  return limited.map(slimSpanRow);
}

/**
 * @param {object[]} spanRows
 * @returns {object}
 */
export function summarizeBloomGpuCoverage(spanRows) {
  let blockedSamples = 0;
  let gpuSamples = 0;
  for (const row of spanRows) {
    blockedSamples += Number(row.gpuBlocked) || 0;
    gpuSamples += Number(row.gpuCount) || 0;
  }
  return {
    spansWithGpuSamples: spanRows.filter((r) => (r.gpuCount ?? 0) > 0).length,
    gpuTimedSamples: gpuSamples,
    blockedSamples,
    nestedSpanNote:
      'Parent `bloom.postMerge` is cpuOnly. GPU spans rotate via gpuSlot (prep / highPass / shared blur mips / final combine). '
      + 'Trust `bloom.render.core.blurMips` gpuAvg for mip-chain cost; CPU sub-spans show composite/upscale draw-call deltas.',
  };
}

/**
 * @param {object[]} spanRows
 * @param {object|null} live
 * @returns {object|null}
 */
export function summarizeBloomGpuRollup(spanRows, live = null) {
  let prepGpu = 0;
  let highPassGpu = 0;
  let blurMipsGpu = 0;
  let outputGpu = 0;
  let blurMipsCpu = 0;
  let compositeCpu = 0;
  let upscaleCpu = 0;

  for (const row of spanRows) {
    const span = String(row.span ?? '');
    const gpuAvg = Number(row.gpuAvg) || 0;
    const cpuAvg = Number(row.cpuAvg) || 0;
    if (span.includes('prepInput') || span.includes('fogInputMask') || span.includes('preBloomSnapshot')) {
      prepGpu += gpuAvg;
    } else if (span.includes('core.highPass')) {
      highPassGpu += gpuAvg;
    } else if (span.includes('core.blurMips')) {
      blurMipsGpu += gpuAvg;
      blurMipsCpu += cpuAvg;
    } else if (span.includes('finalCombine.draw') || span.includes('bloomComposite.draw') || span.includes('outputCopy')) {
      outputGpu += gpuAvg;
    } else if (span.includes('core.composite')) {
      compositeCpu += cpuAvg;
    } else if (span.includes('core.upscale') || span.includes('.upscalePolish')) {
      upscaleCpu += cpuAvg;
    }
  }

  const compositorWrap = spanRows.find((r) => r.span === 'bloom.postMerge' && r.phase === 'render');
  const compositorCpuAvg = Number(compositorWrap?.cpuAvg) || 0;

  if (
    prepGpu <= 0 && highPassGpu <= 0 && blurMipsGpu <= 0 && outputGpu <= 0
    && compositorCpuAvg <= 0
    && !live?.bloomActive
  ) {
    return null;
  }

  const estimatedGpuFromSlots = prepGpu + highPassGpu + blurMipsGpu + outputGpu;

  return {
    prepGpuAvgMs: round2(prepGpu),
    highPassGpuAvgMs: round2(highPassGpu),
    blurMipsGpuAvgMs: round2(blurMipsGpu),
    outputGpuAvgMs: round2(outputGpu),
    estimatedBloomGpuAvgMs: round2(estimatedGpuFromSlots),
    compositorWrapCpuAvgMs: round2(compositorCpuAvg),
    blurMipsCpuAvgMs: round2(blurMipsCpu),
    compositeCpuAvgMs: round2(compositeCpu),
    upscaleCpuAvgMs: round2(upscaleCpu),
    estimatedFullscreenPasses: live?.estimatedFullscreenPassesPerFrame ?? null,
    surfaceLayerActive: live?.surfaceActive ?? null,
    atmoLayerActive: live?.atmoActive ?? null,
  };
}

/**
 * @param {object|null} v2PassTimings
 * @returns {object|null}
 */
export function buildBloomPassTimings(v2PassTimings) {
  const row = v2PassTimings?.postMerge_bloom;
  if (!row) return null;
  return {
    postMerge_bloom: {
      avg: round2(row.avg),
      last: round2(row.last),
      total: round2(row.total),
      count: row.count ?? 0,
    },
  };
}

/**
 * @param {object} snapshot
 * @param {{ spanCap?: number|null }} [options]
 * @returns {object|null}
 */
export function buildBloomPerfSection(snapshot, options = {}) {
  const effects = snapshot?.effects ?? [];
  const hasSpans = effects.some((r) => isBloomEffectKey(r.effect));
  const bloom = resolveBloomEffect();
  const live = typeof bloom?.getPerformanceRecorderSnapshot === 'function'
    ? bloom.getPerformanceRecorderSnapshot(
      window?.MapShine?.effectComposer?._floorCompositorV2?.renderer
        ?? window?.MapShine?.floorCompositorV2?.renderer
        ?? null,
    )
    : null;
  if (!hasSpans && !live) return null;

  const spanCap = options.spanCap ?? null;
  const spanRows = buildBloomSpanRows(effects, { cap: spanCap });
  const gpuCoverage = summarizeBloomGpuCoverage(spanRows);
  const gpuRollup = summarizeBloomGpuRollup(spanRows, live);
  const passes = buildBloomPassTimings(snapshot?.v2PassTimings);

  return {
    note:
      'Dual-layer bloom from one shared mip chain — surface and atmosphere differ in composite weights only. '
      + 'Parent `bloom.postMerge` is cpuOnly — use `bloom.spans` for sub-pass cost. '
      + 'GPU timer rotates across prep, highPass, shared blur mips, and final combine. '
      + '`live.estimatedFullscreenPassesPerFrame` counts expected fullscreen draws when bloom is active.',
    live,
    spans: spanRows,
    passes,
    gpuCoverage,
    gpuRollup,
  };
}

/**
 * @param {object} snapshot
 * @returns {object|null}
 */
export function buildSummaryBloomSection(snapshot) {
  return buildBloomPerfSection(snapshot, { spanCap: SUMMARY_BLOOM_SPANS_CAP });
}
