/**
 * @fileoverview Performance Recorder JSON export builders (summary vs full).
 * Pure functions — no DOM dependency.
 *
 * @module core/diagnostics/performance-recorder-export
 */

export const EXPORT_MODE_SUMMARY = 'summary';
export const EXPORT_MODE_FULL = 'full';

export const EXPORT_SCHEMA_VERSION = 1;

/** Max grouped effect rows in summary JSON. */
const SUMMARY_EFFECTS_CAP = 40;

/** Max long-task entries in summary `longTasks.top`. */
const SUMMARY_LONG_TASKS_TOP = 10;

/**
 * Roll dotted effect keys to parent (e.g. cloud.update.foo → cloud.update).
 * @param {string} effect
 * @returns {string}
 */
export function rollupEffectKey(effect) {
  const parts = String(effect ?? '').split('.');
  if (parts.length >= 3) return `${parts[0]}.${parts[1]}`;
  return String(effect ?? '');
}

/**
 * Group per-span effect rows by rollup key + phase (dialog table grouping).
 * @param {object[]} effects
 * @returns {object[]}
 */
export function groupEffectRows(effects) {
  /** @type {Map<string, object>} */
  const map = new Map();
  for (const row of effects ?? []) {
    const key = `${rollupEffectKey(row.effect)}/${row.phase}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        effect: rollupEffectKey(row.effect),
        phase: row.phase,
        cpuLast: 0,
        cpuAvg: 0,
        cpuMax: 0,
        cpuTotal: 0,
        cpuCount: 0,
        gpuLast: 0,
        gpuAvg: 0,
        gpuMax: 0,
        gpuTotal: 0,
        gpuCount: 0,
        drawCallsAvg: 0,
        trianglesAvg: 0,
        linesAvg: 0,
        pointsAvg: 0,
        gpuDisjointDropped: 0,
        gpuMissing: 0,
        gpuBlocked: 0,
        _drawWeighted: 0,
        _triWeighted: 0,
      };
      map.set(key, agg);
    }
    agg.cpuLast = row.cpuLast;
    agg.cpuMax = Math.max(agg.cpuMax, row.cpuMax ?? 0);
    agg.cpuTotal += row.cpuTotal ?? 0;
    agg.cpuCount += row.cpuCount ?? 0;
    agg.gpuLast = row.gpuLast;
    agg.gpuMax = Math.max(agg.gpuMax, row.gpuMax ?? 0);
    agg.gpuTotal += row.gpuTotal ?? 0;
    agg.gpuCount = Math.max(agg.gpuCount, row.gpuCount ?? 0);
    agg.gpuDisjointDropped += row.gpuDisjointDropped ?? 0;
    agg.gpuMissing += row.gpuMissing ?? 0;
    agg.gpuBlocked += row.gpuBlocked ?? 0;
    const count = row.cpuCount ?? 0;
    agg._drawWeighted += (row.drawCallsAvg ?? 0) * count;
    agg._triWeighted += (row.trianglesAvg ?? 0) * count;
  }
  return [...map.values()].map((agg) => {
    const count = agg.cpuCount || 1;
    return {
      ...agg,
      cpuAvg: agg.cpuTotal / count,
      gpuAvg: agg.gpuCount > 0 ? agg.gpuTotal / agg.gpuCount : 0,
      drawCallsAvg: agg._drawWeighted / count,
      trianglesAvg: agg._triWeighted / count,
      cost: (agg.cpuTotal / count) + (agg.gpuCount > 0 ? agg.gpuTotal / agg.gpuCount : 0),
    };
  });
}

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
 * @param {object} row
 * @returns {boolean}
 */
function keepSummaryEffectRow(row) {
  const cpuTotal = Number(row.cpuTotal) || 0;
  const gpuTotal = Number(row.gpuTotal) || 0;
  const cpuMax = Number(row.cpuMax) || 0;
  const gpuMax = Number(row.gpuMax) || 0;
  const cpuCount = Number(row.cpuCount) || 0;
  const gpuBlocked = Number(row.gpuBlocked) || 0;
  if (cpuTotal + gpuTotal >= 1) return true;
  if (Math.max(cpuMax, gpuMax) >= 2) return true;
  if (gpuBlocked >= cpuCount * 0.5) return true;
  return false;
}

/**
 * @param {object} row
 * @returns {object}
 */
function slimSummaryEffectRow(row) {
  /** @type {Record<string, unknown>} */
  const out = {
    effect: row.effect,
    phase: row.phase,
    cpuTotal: round2(row.cpuTotal),
    cpuAvg: round2(row.cpuAvg),
    cpuMax: round2(row.cpuMax),
    gpuTotal: round2(row.gpuTotal),
    gpuAvg: round2(row.gpuAvg),
    gpuMax: round2(row.gpuMax),
  };
  if ((row.drawCallsAvg ?? 0) > 0) out.drawCallsAvg = round2(row.drawCallsAvg);
  if ((row.trianglesAvg ?? 0) > 0) out.trianglesAvg = round2(row.trianglesAvg);
  if ((row.gpuBlocked ?? 0) > 0) out.gpuBlocked = row.gpuBlocked;
  if ((row.gpuMissing ?? 0) > 0) out.gpuMissing = row.gpuMissing;
  return out;
}

/**
 * @param {object[]} effects
 * @returns {object[]}
 */
export function buildSummaryEffects(effects) {
  const grouped = groupEffectRows(effects)
    .filter(keepSummaryEffectRow)
    .sort((a, b) => (b.cpuTotal + b.gpuTotal) - (a.cpuTotal + a.gpuTotal))
    .slice(0, SUMMARY_EFFECTS_CAP);
  return grouped.map(slimSummaryEffectRow);
}

/**
 * @param {object[]} longTasks
 * @returns {{ buffered: number, maxMs: number, p95Ms: number, top: object[] }}
 */
export function summarizeLongTasks(longTasks) {
  const tasks = longTasks ?? [];
  const durations = tasks.map((t) => Number(t.durationMs) || 0);
  const top = tasks
    .slice()
    .sort((a, b) => (Number(b.durationMs) || 0) - (Number(a.durationMs) || 0))
    .slice(0, SUMMARY_LONG_TASKS_TOP);
  return {
    buffered: tasks.length,
    maxMs: round2(durations.reduce((m, v) => Math.max(m, v), 0)),
    p95Ms: round2(percentile(durations, 0.95)),
    top,
  };
}

/**
 * @param {object|null|undefined} sequencer
 * @returns {object|null|undefined}
 */
function trimSequencerForSummary(sequencer) {
  if (!sequencer) return sequencer;
  const out = { ...sequencer };
  if (!out.mirrors?.length) delete out.mirrors;
  if (!out.phases?.length) delete out.phases;
  return out;
}

/**
 * @param {string} sceneName
 * @returns {string}
 */
function sceneSlug(sceneName) {
  const raw = String(sceneName ?? '').trim() || 'scene';
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 48) || 'scene';
}

/**
 * @param {import('./PerformanceRecorder.js').PerformanceRecorder} recorder
 * @param {'summary'|'full'} mode
 * @returns {string}
 */
export function buildExportFilename(recorder, mode) {
  const wall = recorder._startedAtWallClockMs || Date.now();
  const d = new Date(wall);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ts = `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
  const ctx = recorder.getSnapshot?.()?.meta?.context ?? {};
  const slug = sceneSlug(ctx.sceneName);
  if (mode === EXPORT_MODE_SUMMARY) {
    return `map-shine-perf-summary-${slug}-${ts}.json`;
  }
  return `map-shine-perf-${slug}-${ts}.json`;
}

/**
 * @param {import('./PerformanceRecorder.js').PerformanceRecorder} recorder
 * @returns {object}
 */
export function buildSummaryPayload(recorder) {
  const snap = recorder.getSnapshot();
  const {
    effects: _effects,
    longTasks: rawLongTasks,
    sequencer,
    ...rest
  } = snap;

  const insights = recorder.getInsights?.() ?? [];

  return {
    ...rest,
    meta: {
      ...snap.meta,
      export: { mode: EXPORT_MODE_SUMMARY, schemaVersion: EXPORT_SCHEMA_VERSION },
    },
    effects: buildSummaryEffects(_effects),
    longTasks: summarizeLongTasks(rawLongTasks),
    sequencer: trimSequencerForSummary(sequencer),
    insights,
    generatedAtMs: performance.now(),
  };
}

/**
 * @param {import('./PerformanceRecorder.js').PerformanceRecorder} recorder
 * @returns {object}
 */
export function buildFullPayload(recorder) {
  const snap = recorder.getSnapshot();
  return {
    ...snap,
    meta: {
      ...snap.meta,
      export: { mode: EXPORT_MODE_FULL, schemaVersion: EXPORT_SCHEMA_VERSION },
    },
    frames: recorder._frames.slice(),
    ticks: recorder._tickRecords.slice(),
    generatedAtMs: performance.now(),
  };
}

/**
 * @param {import('./PerformanceRecorder.js').PerformanceRecorder} recorder
 * @param {{ mode?: string }} [options]
 * @returns {'summary'|'full'}
 */
export function resolveExportMode(options = {}) {
  return options.mode === EXPORT_MODE_FULL ? EXPORT_MODE_FULL : EXPORT_MODE_SUMMARY;
}
