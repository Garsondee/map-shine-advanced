/**
 * @fileoverview World overlay (post-bloom splashes + vegetation) profiler helpers.
 *
 * @module core/diagnostics/performance-recorder-world-overlays
 */

/** Max detailed span rows in summary JSON exports. */
export const SUMMARY_WORLD_OVERLAYS_SPANS_CAP = 24;

/**
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * @param {string} effect
 * @returns {boolean}
 */
function isWorldOverlaysEffectKey(effect) {
  const key = String(effect ?? '');
  return key === 'postBloom.worldOverlays' || key.startsWith('postBloom.worldOverlays.');
}

/**
 * @returns {object|null}
 */
export function resolveFloorCompositor() {
  try {
    return window?.MapShine?.effectComposer?._floorCompositorV2
      ?? window?.MapShine?.floorCompositorV2
      ?? null;
  } catch (_) {
    return null;
  }
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
export function buildWorldOverlaysSpanRows(effects, options = {}) {
  const cap = options.cap ?? null;
  const rows = [];
  for (const row of effects ?? []) {
    if (!isWorldOverlaysEffectKey(row.effect)) continue;
    const span = row.effect === 'postBloom.worldOverlays'
      ? `postBloom.worldOverlays (${row.phase})`
      : row.effect;
    rows.push({
      span,
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
export function summarizeWorldOverlaysGpuCoverage(spanRows) {
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
      'Parent `postBloom.worldOverlays` is cpuOnly so splashes/vegetation draw spans can claim the GPU timer sequentially. Sum splashes + vegetation.draw.* gpuAvg for approximate per-frame overlay GPU.',
  };
}

/**
 * @param {object[]} spanRows
 * @returns {object|null}
 */
export function summarizeWorldOverlaysGpuRollup(spanRows) {
  let splashesGpu = 0;
  let vegetationDrawGpu = 0;
  let vegetationSyncCpu = 0;
  for (const row of spanRows) {
    const span = String(row.span ?? '');
    if (span.includes('splashes')) splashesGpu += Number(row.gpuAvg) || 0;
    else if (span.includes('vegetation.draw.')) vegetationDrawGpu += Number(row.gpuAvg) || 0;
    else if (span.includes('vegetation.sync')) vegetationSyncCpu += Number(row.cpuAvg) || 0;
  }
  if (splashesGpu <= 0 && vegetationDrawGpu <= 0 && vegetationSyncCpu <= 0) return null;
  return {
    splashesGpuAvgMs: round2(splashesGpu),
    vegetationDrawGpuAvgMs: round2(vegetationDrawGpu),
    vegetationSyncCpuAvgMs: round2(vegetationSyncCpu),
    estimatedOverlayGpuAvgMs: round2(splashesGpu + vegetationDrawGpu),
  };
}

/**
 * @param {object} snapshot
 * @param {{ spanCap?: number|null }} [options]
 * @returns {object|null}
 */
export function buildWorldOverlaysPerfSection(snapshot, options = {}) {
  const effects = snapshot?.effects ?? [];
  const hasSpans = effects.some((r) => isWorldOverlaysEffectKey(r.effect));
  const fc = resolveFloorCompositor();
  const live = typeof fc?.getWorldOverlaysRecorderSnapshot === 'function'
    ? fc.getWorldOverlaysRecorderSnapshot()
    : null;
  if (!hasSpans && !live) return null;

  const spanCap = options.spanCap ?? null;
  const spanRows = buildWorldOverlaysSpanRows(effects, { cap: spanCap });
  const gpuCoverage = summarizeWorldOverlaysGpuCoverage(spanRows);
  const gpuRollup = summarizeWorldOverlaysGpuRollup(spanRows);

  return {
    note:
      'Post-bloom world overlays composite water splashes and bush/tree vegetation onto the HDR buffer. '
      + 'Use `worldOverlays.spans` — especially `postBloom.worldOverlays.vegetation.draw.*` — to see which overlay kind dominates GPU.',
    live,
    spans: spanRows,
    gpuCoverage,
    gpuRollup,
  };
}

/**
 * @param {object} snapshot
 * @returns {object|null}
 */
export function buildSummaryWorldOverlaysSection(snapshot) {
  return buildWorldOverlaysPerfSection(snapshot, { spanCap: SUMMARY_WORLD_OVERLAYS_SPANS_CAP });
}
