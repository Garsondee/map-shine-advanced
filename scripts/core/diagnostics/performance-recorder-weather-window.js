/**
 * @fileoverview Weather particles + window light profiler helpers for Performance Recorder.
 *
 * @module core/diagnostics/performance-recorder-weather-window
 */

/** Max detailed span rows in summary JSON exports. */
export const SUMMARY_WEATHER_WINDOW_SPANS_CAP = 24;

/**
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
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
 * @param {string} effect
 * @param {string} prefix
 * @returns {boolean}
 */
function isPrefixedEffectKey(effect, prefix) {
  const key = String(effect ?? '');
  return key === prefix || key.startsWith(`${prefix}.`);
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
 * @param {string} prefix - e.g. `weatherParticles` or `windowLight`
 * @param {{ cap?: number|null }} [options]
 * @returns {object[]}
 */
export function buildPrefixedSpanRows(effects, prefix, options = {}) {
  const cap = options.cap ?? null;
  const rows = [];
  for (const row of effects ?? []) {
    if (!isPrefixedEffectKey(row.effect, prefix)) continue;
    const span = row.effect;
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
  if (cap != null && cap > 0) return rows.slice(0, cap).map(slimSpanRow);
  return rows.map(slimSpanRow);
}

/**
 * @param {object[]} effects
 * @param {{ cap?: number|null }} [options]
 * @returns {object[]}
 */
export function buildWeatherSpanRows(effects, options = {}) {
  return buildPrefixedSpanRows(effects, 'weatherParticles', options);
}

/**
 * @param {object[]} effects
 * @param {{ cap?: number|null }} [options]
 * @returns {object[]}
 */
export function buildWindowLightSpanRows(effects, options = {}) {
  return buildPrefixedSpanRows(effects, 'windowLight', options);
}

/**
 * @param {object[]} effects
 * @returns {number}
 */
function sumGpuBlockedForPrefix(effects, prefix) {
  let total = 0;
  for (const row of effects ?? []) {
    if (!isPrefixedEffectKey(row.effect, prefix)) continue;
    total += Number(row.gpuBlocked) || 0;
  }
  return total;
}

/**
 * @param {object} params
 * @param {object[]} params.effects
 * @returns {object|null}
 */
export function buildWeatherPerfSection({ effects }) {
  const spans = buildWeatherSpanRows(effects, { cap: SUMMARY_WEATHER_WINDOW_SPANS_CAP });
  if (spans.length === 0) return null;

  const fc = resolveFloorCompositor();
  let live = null;
  try {
    live = fc?._weatherParticles?.getPerformanceSnapshot?.() ?? null;
  } catch (_) {}

  const updateSpans = spans.filter((s) => s.phase === 'update');
  const topUpdate = updateSpans[0] ?? spans[0] ?? null;

  return {
    spans,
    live,
    topUpdateSpan: topUpdate?.span ?? null,
    gpuCoverage: {
      blockedSamples: sumGpuBlockedForPrefix(effects, 'weatherParticles'),
      note: 'Weather update spans are CPU-only; Quarks draw cost is in the main bus pass.',
    },
  };
}

/**
 * @param {object} params
 * @param {object[]} params.effects
 * @returns {object|null}
 */
export function buildWindowLightPerfSection({ effects }) {
  const spans = buildWindowLightSpanRows(effects, { cap: SUMMARY_WEATHER_WINDOW_SPANS_CAP });
  if (spans.length === 0) return null;

  const fc = resolveFloorCompositor();
  let live = null;
  try {
    live = fc?._windowLightEffect?.getEmitPerformanceSnapshot?.() ?? null;
  } catch (_) {}

  const renderSpans = spans.filter((s) => s.phase === 'render');
  const updateSpans = spans.filter((s) => s.phase === 'update');
  const topRender = renderSpans[0] ?? null;
  const topUpdate = updateSpans[0] ?? null;

  return {
    spans,
    live,
    topRenderSpan: topRender?.span ?? null,
    topUpdateSpan: topUpdate?.span ?? null,
    gpuCoverage: {
      blockedSamples: sumGpuBlockedForPrefix(effects, 'windowLight'),
      note: 'windowLight.render.emitDraw uses gpuSlot 1/2; lighting.render.windowLightDraw.sceneDraw uses slot 0/2.',
    },
  };
}

/**
 * @param {object} snapshot
 * @returns {object|null}
 */
export function buildSummaryWeatherSection(snapshot) {
  const section = snapshot?.weatherParticles ?? buildWeatherPerfSection({
    effects: snapshot?.effects ?? [],
  });
  if (!section?.spans?.length) return section?.live ? { live: section.live } : null;
  return {
    spans: section.spans.slice(0, SUMMARY_WEATHER_WINDOW_SPANS_CAP),
    live: section.live ?? null,
    topUpdateSpan: section.topUpdateSpan ?? null,
    gpuCoverage: section.gpuCoverage ?? null,
  };
}

/**
 * @param {object} snapshot
 * @returns {object|null}
 */
export function buildSummaryWindowLightSection(snapshot) {
  const section = snapshot?.windowLight ?? buildWindowLightPerfSection({
    effects: snapshot?.effects ?? [],
  });
  if (!section?.spans?.length) return section?.live ? { live: section.live } : null;
  return {
    spans: section.spans.slice(0, SUMMARY_WEATHER_WINDOW_SPANS_CAP),
    live: section.live ?? null,
    topRenderSpan: section.topRenderSpan ?? null,
    topUpdateSpan: section.topUpdateSpan ?? null,
    gpuCoverage: section.gpuCoverage ?? null,
  };
}
