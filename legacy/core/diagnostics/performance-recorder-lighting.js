/**
 * @fileoverview Lighting-focused performance recorder helpers.
 * Unrolled `lighting.*` spans, compositor pass timings, and live RT inventory.
 *
 * @module core/diagnostics/performance-recorder-lighting
 */

/** Max detailed span rows in summary JSON exports. */
export const SUMMARY_LIGHTING_SPANS_CAP = 40;

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
function isLightingEffectKey(effect) {
  const key = String(effect ?? '');
  return key === 'lighting' || key.startsWith('lighting.');
}

/**
 * Resolve the active LightingEffectV2 instance from common Map Shine roots.
 * @returns {object|null}
 */
export function resolveLightingEffect() {
  try {
    const fc = window?.MapShine?.effectComposer?._floorCompositorV2
      ?? window?.MapShine?.floorCompositorV2;
    if (fc?._lightingEffect) return fc._lightingEffect;
    return window?.MapShine?.lightingEffectV2 ?? null;
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
function slimLightingSpanRow(row) {
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
  if ((row.gpuMissing ?? 0) > 0) out.gpuMissing = row.gpuMissing;
  return out;
}

/**
 * Build per-span rows for all `lighting` / `lighting.*` recorder keys (no rollup).
 *
 * @param {object[]} effects
 * @param {{ cap?: number|null }} [options]
 * @returns {object[]}
 */
export function buildLightingSpanRows(effects, options = {}) {
  const cap = options.cap ?? null;
  const rows = [];
  for (const row of effects ?? []) {
    if (!isLightingEffectKey(row.effect)) continue;
    const span = row.effect === 'lighting'
      ? `lighting (${row.phase})`
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
      gpuMissing: row.gpuMissing,
    });
  }
  rows.sort((a, b) => spanCost(b) - spanCost(a));
  const limited = cap != null && cap > 0 ? rows.slice(0, cap) : rows;
  return limited.map(slimLightingSpanRow);
}

/**
 * @param {object|null|undefined} v2PassTimings
 * @returns {object[]}
 */
export function buildLightingPassTimings(v2PassTimings) {
  if (!v2PassTimings || typeof v2PassTimings !== 'object') return [];
  const rows = [];
  for (const [name, data] of Object.entries(v2PassTimings)) {
    if (!name.includes('lighting') && !name.includes('alphaRebind')) continue;
    rows.push({
      pass: name,
      avg: round2(data?.avg ?? 0),
      last: round2(data?.last ?? 0),
      total: round2(data?.total ?? 0),
      count: data?.count ?? 0,
    });
  }
  rows.sort((a, b) => b.avg - a.avg);
  return rows;
}

/**
 * @param {object[]} spanRows
 * @param {object[]} effects
 * @returns {object}
 */
export function summarizeLightingTotals(spanRows, effects) {
  let internalCpu = 0;
  let internalGpu = 0;
  let internalDraws = 0;
  let internalTris = 0;
  let internalSamples = 0;
  for (const row of spanRows) {
    const span = String(row.span ?? '');
    if (span.startsWith('lighting (') || span === 'lighting') continue;
    internalCpu += Number(row.cpuTotal) || 0;
    internalGpu += Number(row.gpuTotal) || 0;
    internalSamples += Number(row.cpuCount) || 0;
    internalDraws += (Number(row.drawCallsAvg) || 0) * (Number(row.cpuCount) || 0);
    internalTris += (Number(row.trianglesAvg) || 0) * (Number(row.cpuCount) || 0);
  }

  /** @type {{ phase: string, cpuTotal: number, gpuTotal: number, cpuCount: number }|null} */
  let compositorWrapRender = null;
  /** @type {{ phase: string, cpuTotal: number, gpuTotal: number, cpuCount: number }|null} */
  let compositorWrapUpdate = null;
  for (const row of effects ?? []) {
    if (row.effect !== 'lighting') continue;
    const entry = {
      phase: row.phase,
      cpuTotal: round2(row.cpuTotal),
      gpuTotal: round2(row.gpuTotal),
      cpuCount: row.cpuCount ?? 0,
      cpuAvg: round2(row.cpuAvg),
      gpuAvg: round2(row.gpuAvg),
      gpuBlocked: row.gpuBlocked ?? 0,
    };
    if (row.phase === 'render') compositorWrapRender = entry;
    else if (row.phase === 'update') compositorWrapUpdate = entry;
  }

  const denom = internalSamples || 1;
  return {
    compositorWrap: {
      render: compositorWrapRender,
      update: compositorWrapUpdate,
      note:
        'FloorCompositor `lighting` spans wrap the full render/update call. Nested `lighting.render.*` / `lighting.update.*` spans are included inside the wrap — do not sum wrap + internal for a frame budget.',
    },
    internalSpans: {
      cpuTotalMs: round2(internalCpu),
      gpuTotalMs: round2(internalGpu),
      spanCount: spanRows.filter((r) => !String(r.span).startsWith('lighting (')).length,
      avgDrawCallsPerSample: round2(internalDraws / denom),
      avgTrianglesPerSample: round2(internalTris / denom),
    },
  };
}

/**
 * @param {object[]} spanRows
 * @returns {object}
 */
export function summarizeLightingGpuCoverage(spanRows) {
  let blockedSamples = 0;
  let blockedSpans = 0;
  let gpuSamples = 0;
  for (const row of spanRows) {
    const blocked = Number(row.gpuBlocked) || 0;
    const count = Number(row.cpuCount) || 0;
    gpuSamples += Number(row.gpuCount) || 0;
    if (blocked > 0) {
      blockedSamples += blocked;
      if (blocked >= count * 0.5) blockedSpans += 1;
    }
  }
  return {
    spansWithGpuSamples: spanRows.filter((r) => (r.gpuCount ?? 0) > 0).length,
    gpuTimedSamples: gpuSamples,
    blockedSamples,
    blockedSpans,
    nestedSpanNote:
      'Nested lighting spans often mark cpuOnly or lose the single active GPU query to parent `lighting` / `lighting.render` — trust compositorWrap GPU or perLevel_lighting_* pass timings.',
  };
}

/**
 * @param {object} snapshot
 * @param {{ spanCap?: number|null }} [options]
 * @returns {object|null}
 */
export function buildLightingPerfSection(snapshot, options = {}) {
  const effects = snapshot?.effects ?? [];
  const hasLighting = effects.some((r) => isLightingEffectKey(r.effect));
  const live = resolveLightingEffect()?.getPerformanceRecorderSnapshot?.() ?? null;
  if (!hasLighting && !live) return null;

  const spanCap = options.spanCap ?? null;
  const spanRows = buildLightingSpanRows(effects, { cap: spanCap });
  const passes = buildLightingPassTimings(snapshot?.v2PassTimings);
  const totals = summarizeLightingTotals(spanRows, effects);
  const gpuCoverage = summarizeLightingGpuCoverage(spanRows);

  const session = snapshot?.session ?? {};
  const frameAvg = Number(session.frameTime?.avg) || 0;
  const compositorGpuAvg = Number(totals.compositorWrap?.render?.gpuAvg) || 0;
  const shareOfFrameGpuPct = frameAvg > 0 && compositorGpuAvg > 0
    ? round2((compositorGpuAvg / frameAvg) * 100)
    : null;

  const emitCounters = live?.emit?.sessionCounters ?? null;
  const emitDrawsPerFrame = emitCounters
    ? {
      full: emitCounters.fullDraws ?? 0,
      shadowLift: emitCounters.shadowLiftDraws ?? 0,
      skippedFull: emitCounters.skippedFullDraws ?? 0,
    }
    : null;

  return {
    note:
      'Detailed lighting spans are not rolled up in `effects` (summary export groups `cloud.update.foo` → `cloud.update` only). Use `lighting.spans` for sub-pass targeting. Nested `lighting.render.*` spans with gpuSlot alternate GPU samples; parent `lighting` render wrap is cpuOnly.',
    live: live
      ? {
        ...live,
        emitDrawsPerFrame,
        windowLightTextureSource: live.windowLightTextureSource ?? live.emit?.windowLightTextureSource ?? 'emit',
      }
      : null,
    spans: spanRows,
    passes,
    totals,
    gpuCoverage,
    frameBudgetHint: shareOfFrameGpuPct != null
      ? {
        compositorWrapGpuAvgMs: compositorGpuAvg,
        sessionFrameTimeAvgMs: round2(frameAvg),
        compositorWrapGpuShareOfFramePct: shareOfFrameGpuPct,
      }
      : null,
  };
}

/**
 * @param {object} snapshot
 * @returns {object|null}
 */
export function buildSummaryLightingSection(snapshot) {
  return buildLightingPerfSection(snapshot, { spanCap: SUMMARY_LIGHTING_SPANS_CAP });
}
