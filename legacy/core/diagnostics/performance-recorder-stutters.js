/**
 * @fileoverview Stutter / freeze classification from Performance Recorder timelines.
 * Pure functions — no DOM dependency.
 *
 * @module core/diagnostics/performance-recorder-stutters
 */

/** Minimum gap (ms) before any stutter classification applies. */
export const STUTTER_MIN_GAP_MS = 25;

/** rAF handler duration treated as over-budget (≈30 fps). */
export const TICK_OVERBUDGET_MS = 34;

/** Gap duration (ms) classified as a genuine freeze. */
export const FREEZE_GAP_MS = 500;

/** Default cap on exported stutter events. */
export const DEFAULT_MAX_STUTTER_EVENTS = 50;

/**
 * @typedef {'raf_gap'|'present_gap'|'compositor_spike'|'tick_overbudget'|'freeze'} StutterKind
 */

/**
 * @typedef {'warn'|'critical'} StutterSeverity
 */

/**
 * @typedef {object} StutterEvent
 * @property {StutterKind} kind
 * @property {StutterSeverity} severity
 * @property {number} tMs - Session-relative timestamp (ms)
 * @property {number} [seq] - Compositor frame seq when applicable
 * @property {number} [gapMs]
 * @property {number} [tickMs]
 * @property {number} [frameTimeMs]
 * @property {number} [compositorMs]
 * @property {number} [handlerOverheadMs]
 * @property {number} [sinceLastPresentMs]
 * @property {number} [targetFps]
 * @property {string|null} [continuousReason]
 * @property {string|null} [renderPath]
 * @property {Array<{ effect: string, phase: string, cpuMs: number }>} [topEffects]
 * @property {Array<{ startMs: number, durationMs: number, name: string|null }>} [longTasks]
 */

/**
 * @typedef {object} MetricSummary
 * @property {number} p50
 * @property {number} p95
 * @property {number} p99
 * @property {number} max
 * @property {number} avg
 * @property {number} count
 */

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
 * @param {number} ms
 * @returns {string}
 */
function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '0';
  return ms >= 100 ? ms.toFixed(1) : ms.toFixed(2);
}

/**
 * @param {number} targetFps
 * @returns {number}
 */
function gapThresholdForTargetFps(targetFps) {
  const interval = targetFps > 0 ? 1000 / targetFps : 1000 / 60;
  return Math.max(STUTTER_MIN_GAP_MS, interval * 2);
}

/**
 * @param {object[]} ticks
 * @returns {object[]}
 */
function sortTicksChronological(ticks) {
  return (ticks ?? [])
    .filter((t) => t && Number.isFinite(t.tMs))
    .slice()
    .sort((a, b) => a.tMs - b.tMs);
}

/**
 * @param {object[]} frames
 * @returns {object[]}
 */
function sortFramesChronological(frames) {
  return (frames ?? [])
    .filter((f) => f && Number.isFinite(f.tMs))
    .slice()
    .sort((a, b) => a.tMs - b.tMs);
}

/**
 * @param {object[]} frames
 * @param {number} tMs
 * @returns {object|null}
 */
function nearestFrameAtTime(frames, tMs) {
  let best = null;
  let bestDist = Infinity;
  for (const f of frames) {
    const dist = Math.abs(f.tMs - tMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = f;
    }
  }
  return bestDist <= 50 ? best : null;
}

/**
 * @param {Array<{ startMs: number, durationMs: number, name?: string|null }>} longTasks
 * @param {number} gapStartMs
 * @param {number} gapEndMs
 * @returns {Array<{ startMs: number, durationMs: number, name: string|null }>}
 */
function longTasksOverlappingGap(longTasks, gapStartMs, gapEndMs) {
  const out = [];
  for (const lt of longTasks ?? []) {
    if (!lt || !Number.isFinite(lt.durationMs)) continue;
    const endMs = Number(lt.endMs ?? lt.startMs + lt.durationMs);
    const startMs = Number(lt.startMs ?? endMs - lt.durationMs);
    if (endMs > gapStartMs && startMs < gapEndMs) {
      out.push({
        startMs,
        durationMs: lt.durationMs,
        name: lt.name ?? lt.attribution ?? null,
      });
    }
  }
  return out;
}

/**
 * @param {number[]} values
 * @returns {MetricSummary}
 */
function summarizeMetric(values) {
  const arr = (values ?? []).filter((v) => Number.isFinite(v));
  if (arr.length === 0) {
    return { p50: 0, p95: 0, p99: 0, max: 0, avg: 0, count: 0 };
  }
  const sum = arr.reduce((s, v) => s + v, 0);
  return {
    p50: percentile(arr, 0.5),
    p95: percentile(arr, 0.95),
    p99: percentile(arr, 0.99),
    max: Math.max(...arr),
    avg: sum / arr.length,
    count: arr.length,
  };
}

/**
 * @param {StutterKind} kind
 * @param {number} valueMs
 * @param {number} thresholdMs
 * @returns {StutterSeverity}
 */
function severityFor(kind, valueMs, thresholdMs) {
  if (kind === 'freeze') return 'critical';
  if (valueMs >= thresholdMs * 2.5) return 'critical';
  if (kind === 'compositor_spike' && valueMs >= thresholdMs * 1.5) return 'critical';
  return 'warn';
}

/**
 * Classify stutters and freezes from recorder timelines.
 *
 * @param {object[]} frames - Compositor frame records
 * @param {object[]} ticks - rAF tick records
 * @param {object} [options]
 * @param {number} [options.maxEvents]
 * @param {number} [options.compositorSpikeThresholdMs] - Override; default max(20, frame p95×1.5)
 * @param {Array<{ startMs: number, endMs?: number, durationMs: number, name?: string|null, attribution?: string|null }>} [options.longTasks]
 * @param {Map<number, { seq: number, tMs: number, frameTimeMs: number, topEffects: object[] }>} [options.spikeDetailsBySeq]
 * @returns {{ summary: object, events: StutterEvent[], countsByKind: Record<string, number> }}
 */
export function analyzeStutters(frames, ticks, options = {}) {
  const maxEvents = Math.max(1, Number(options.maxEvents) || DEFAULT_MAX_STUTTER_EVENTS);
  const longTasks = options.longTasks ?? [];
  const spikeDetailsBySeq = options.spikeDetailsBySeq ?? new Map();

  const sortedTicks = sortTicksChronological(ticks);
  const sortedFrames = sortFramesChronological(frames);

  const frameTimes = sortedFrames.map((f) => f.frameTimeMs);
  const frameP95 = percentile(frameTimes, 0.95);
  const compositorSpikeThreshold = Number.isFinite(options.compositorSpikeThresholdMs)
    ? options.compositorSpikeThresholdMs
    : Math.max(20, frameP95 * 1.5);

  /** @type {StutterEvent[]} */
  const events = [];

  const rafGaps = [];
  const presentGaps = [];
  const tickMsValues = [];
  const nonCompositorValues = [];

  for (let i = 1; i < sortedTicks.length; i++) {
    const prev = sortedTicks[i - 1];
    const tick = sortedTicks[i];
    const gapMs = tick.tMs - prev.tMs;
    if (!Number.isFinite(gapMs) || gapMs <= 0) continue;

    rafGaps.push(gapMs);
    const targetFps = Number(tick.targetFps) || 60;
    const threshold = gapThresholdForTargetFps(targetFps);

    if (gapMs >= FREEZE_GAP_MS) {
      const matched = nearestFrameAtTime(sortedFrames, tick.tMs);
      const overlap = longTasksOverlappingGap(longTasks, prev.tMs, tick.tMs);
      events.push({
        kind: 'freeze',
        severity: 'critical',
        tMs: tick.tMs,
        seq: matched?.seq,
        gapMs,
        tickMs: tick.tickMs,
        frameTimeMs: matched?.frameTimeMs,
        compositorMs: tick.compositorMs,
        handlerOverheadMs: tick.handlerOverheadMs,
        targetFps,
        continuousReason: tick.continuousReason ?? matched?.continuousReason ?? null,
        renderPath: tick.renderPath ?? null,
        longTasks: overlap.length > 0 ? overlap : undefined,
      });
    } else if (gapMs >= threshold) {
      const matched = nearestFrameAtTime(sortedFrames, tick.tMs);
      const overlap = longTasksOverlappingGap(longTasks, prev.tMs, tick.tMs);
      events.push({
        kind: 'raf_gap',
        severity: severityFor('raf_gap', gapMs, threshold),
        tMs: tick.tMs,
        seq: matched?.seq,
        gapMs,
        tickMs: tick.tickMs,
        frameTimeMs: matched?.frameTimeMs,
        compositorMs: tick.compositorMs,
        handlerOverheadMs: tick.handlerOverheadMs,
        targetFps,
        continuousReason: tick.continuousReason ?? matched?.continuousReason ?? null,
        renderPath: tick.renderPath ?? null,
        longTasks: overlap.length > 0 ? overlap : undefined,
      });
    }

    if (tick.presented) {
      presentGaps.push(Number(tick.sinceLastPresentMs) || 0);
      tickMsValues.push(Number(tick.tickMs) || 0);

      const compositorMs = Number(tick.compositorMs) || 0;
      const overhead = Number(tick.handlerOverheadMs);
      if (compositorMs > 0 && Number.isFinite(overhead)) {
        nonCompositorValues.push(overhead);
      } else if (compositorMs > 0) {
        nonCompositorValues.push(Math.max(0, tick.tickMs - compositorMs));
      }

      const presentThreshold = gapThresholdForTargetFps(targetFps);
      const sincePresent = Number(tick.sinceLastPresentMs) || 0;
      if (sincePresent >= presentThreshold) {
        const matched = nearestFrameAtTime(sortedFrames, tick.tMs);
        events.push({
          kind: 'present_gap',
          severity: severityFor('present_gap', sincePresent, presentThreshold),
          tMs: tick.tMs,
          seq: matched?.seq,
          sinceLastPresentMs: sincePresent,
          gapMs: sincePresent,
          tickMs: tick.tickMs,
          frameTimeMs: matched?.frameTimeMs,
          compositorMs: tick.compositorMs,
          handlerOverheadMs: tick.handlerOverheadMs,
          targetFps,
          continuousReason: tick.continuousReason ?? matched?.continuousReason ?? null,
          renderPath: tick.renderPath ?? null,
        });
      }

      if (tick.tickMs > TICK_OVERBUDGET_MS) {
        const matched = nearestFrameAtTime(sortedFrames, tick.tMs);
        events.push({
          kind: 'tick_overbudget',
          severity: severityFor('tick_overbudget', tick.tickMs, TICK_OVERBUDGET_MS),
          tMs: tick.tMs,
          seq: matched?.seq,
          tickMs: tick.tickMs,
          frameTimeMs: matched?.frameTimeMs,
          compositorMs: tick.compositorMs,
          handlerOverheadMs: tick.handlerOverheadMs,
          targetFps,
          continuousReason: tick.continuousReason ?? matched?.continuousReason ?? null,
          renderPath: tick.renderPath ?? null,
        });
      }
    }
  }

  for (const frame of sortedFrames) {
    if (frame.frameTimeMs >= compositorSpikeThreshold) {
      const detail = spikeDetailsBySeq.get(frame.seq);
      events.push({
        kind: 'compositor_spike',
        severity: severityFor('compositor_spike', frame.frameTimeMs, compositorSpikeThreshold),
        tMs: frame.tMs,
        seq: frame.seq,
        frameTimeMs: frame.frameTimeMs,
        gapMs: frame.frameTimeMs,
        continuousReason: frame.continuousReason ?? null,
        topEffects: detail?.topEffects,
      });
    }
  }

  const severityRank = { critical: 2, warn: 1 };
  const kindRank = { freeze: 5, raf_gap: 4, compositor_spike: 3, tick_overbudget: 2, present_gap: 1 };
  events.sort((a, b) => {
    const sr = (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0);
    if (sr !== 0) return sr;
    const kr = (kindRank[b.kind] ?? 0) - (kindRank[a.kind] ?? 0);
    if (kr !== 0) return kr;
    return (b.gapMs ?? b.frameTimeMs ?? b.tickMs ?? 0) - (a.gapMs ?? a.frameTimeMs ?? a.tickMs ?? 0);
  });

  const countsByKind = {};
  for (const ev of events) {
    countsByKind[ev.kind] = (countsByKind[ev.kind] || 0) + 1;
  }

  const trimmed = events.slice(0, maxEvents);

  return {
    summary: {
      compositorSpikeThresholdMs: compositorSpikeThreshold,
      frameTimeMs: summarizeMetric(frameTimes),
      rafGapMs: summarizeMetric(rafGaps),
      sinceLastPresentMs: summarizeMetric(presentGaps),
      tickMs: summarizeMetric(tickMsValues),
      nonCompositorMs: summarizeMetric(nonCompositorValues),
      countsByKind,
      totalEvents: events.length,
    },
    events: trimmed,
    countsByKind,
  };
}

/**
 * Build insight-oriented summary text for stutter events.
 *
 * @param {{ summary: object, events: StutterEvent[], countsByKind: Record<string, number> }} analysis
 * @returns {string[]}
 */
export function formatStutterEventLines(analysis) {
  const lines = [];
  for (const ev of analysis.events.slice(0, 5)) {
    const sec = (ev.tMs / 1000).toFixed(2);
    const ms = ev.gapMs ?? ev.frameTimeMs ?? ev.tickMs ?? ev.sinceLastPresentMs ?? 0;
    let line = `${ev.kind} @ ${sec}s (${fmtMs(ms)} ms)`;
    if (ev.seq != null) line += ` frame #${ev.seq}`;
    if (ev.topEffects?.length) {
      const tops = ev.topEffects.slice(0, 3).map((e) => `${e.effect}/${e.phase} ${fmtMs(e.cpuMs)}ms`).join(', ');
      line += ` — ${tops}`;
    }
    if (ev.longTasks?.length) {
      const lt = ev.longTasks[0];
      line += ` — long task ${fmtMs(lt.durationMs)}ms${lt.name ? ` (${lt.name})` : ''}`;
    }
    lines.push(line);
  }
  return lines;
}
