/**
 * @fileoverview Auto-generated insights from Performance Recorder snapshots.
 * Pure functions — no DOM dependency.
 *
 * @module core/diagnostics/performance-recorder-insights
 */

import { rollupEffectKey } from './performance-recorder-export.js';
import { analyzeStutters, formatStutterEventLines } from './performance-recorder-stutters.js';
import { buildLightingSpanRows } from './performance-recorder-lighting.js';
import { buildWorldOverlaysSpanRows } from './performance-recorder-world-overlays.js';
import {
  buildWeatherSpanRows,
  buildWindowLightSpanRows,
} from './performance-recorder-weather-window.js';

/**
 * @typedef {'info'|'warn'|'critical'} InsightSeverity
 */

/**
 * @typedef {object} PerformanceInsight
 * @property {InsightSeverity} severity
 * @property {string} title
 * @property {string} detail
 * @property {string[]} tags
 */

/**
 * @param {object[]} effects
 * @param {'cpuTotal'|'gpuTotal'} field
 * @param {number} limit
 * @returns {Array<{ effect: string, phase: string, total: number }>}
 */
function topEffectsByTotal(effects, field, limit = 3) {
  const map = new Map();
  for (const row of effects ?? []) {
    const rolled = rollupEffectKey(row.effect);
    const id = `${rolled}/${row.phase}`;
    const total = Number(row[field]) || 0;
    const prev = map.get(id) ?? { effect: rolled, phase: row.phase, total: 0 };
    prev.total += total;
    map.set(id, prev);
  }
  return [...map.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
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
 * @param {Array<{ seq: number, topEffects?: object[] }>|undefined} details
 * @returns {Map<number, object>}
 */
function buildSpikeDetailsMap(details) {
  const map = new Map();
  for (const row of details ?? []) {
    if (row && Number.isFinite(row.seq)) map.set(row.seq, row);
  }
  return map;
}

/**
 * Build actionable insights from a recorder snapshot and optional timelines.
 *
 * @param {object} snapshot - From PerformanceRecorder.getSnapshot()
 * @param {object[]} [frames] - Frame ring buffer (from export or recorder._frames)
 * @param {object[]} [ticks] - Tick ring buffer
 * @returns {PerformanceInsight[]}
 */
export function buildPerformanceInsights(snapshot, frames = [], ticks = []) {
  /** @type {PerformanceInsight[]} */
  const insights = [];

  const effects = snapshot?.effects ?? [];
  const session = snapshot?.session ?? {};
  const meta = snapshot?.meta ?? {};
  const pacingAnalysis = snapshot?.pacingAnalysis ?? null;

  if ((meta.framesRecorded ?? 0) === 0 && effects.length === 0) {
    return [{
      severity: 'info',
      title: 'No samples yet',
      detail: 'Start recording and exercise the scene for a few seconds.',
      tags: ['session'],
    }];
  }

  // Top CPU offenders
  const topCpu = topEffectsByTotal(effects, 'cpuTotal', 3);
  if (topCpu.length > 0 && topCpu[0].total > 0) {
    const list = topCpu.map((r) => `${r.effect} (${r.phase}) ${fmtMs(r.total)} ms`).join('; ');
    insights.push({
      severity: topCpu[0].total > 150 ? 'warn' : 'info',
      title: 'Top CPU cost',
      detail: list,
      tags: ['cpu', 'effects'],
    });
  }

  // Top GPU offenders
  const topGpu = topEffectsByTotal(effects, 'gpuTotal', 3);
  if (topGpu.length > 0 && topGpu[0].total > 0.5) {
    const list = topGpu.map((r) => `${r.effect} (${r.phase}) ${fmtMs(r.total)} ms GPU`).join('; ');
    insights.push({
      severity: topGpu[0].total > 80 ? 'warn' : 'info',
      title: 'Top GPU cost',
      detail: list,
      tags: ['gpu', 'effects'],
    });
  }

  // Continuous render reason
  const reasons = session.continuousReasons ?? {};
  const reasonTotal = Object.values(reasons).reduce((s, v) => s + v, 0);
  if (reasonTotal > 0) {
    let topReason = 'none';
    let topCount = 0;
    for (const [k, v] of Object.entries(reasons)) {
      if (k !== 'none' && v > topCount) {
        topReason = k;
        topCount = v;
      }
    }
    const share = topCount / reasonTotal;
    if (share > 0.8 && topReason !== 'none') {
      insights.push({
        severity: 'info',
        title: 'Continuous render locked',
        detail: `${topReason} drove ${(share * 100).toFixed(0)}% of compositor frames — expect elevated baseline CPU and adaptive 30 fps tiers when active.`,
        tags: ['continuous', 'pacing'],
      });
    }
  }

  // GPU blocked spans
  let gpuBlockedRows = 0;
  let gpuBlockedTotal = 0;
  for (const row of effects) {
    const blocked = Number(row.gpuBlocked) || 0;
    const count = Number(row.cpuCount) || 0;
    if (blocked > count * 0.5 && blocked > 0) {
      gpuBlockedRows += 1;
      gpuBlockedTotal += blocked;
    }
  }
  if (gpuBlockedRows >= 2) {
    insights.push({
      severity: 'warn',
      title: 'GPU timing partially blocked',
      detail: `${gpuBlockedRows} effect span(s) could not acquire a GPU timer query (${gpuBlockedTotal} blocked samples). GPU totals are sampled, not exhaustive — trust CPU totals or disable nested GPU probes for those passes.`,
      tags: ['gpu', 'coverage'],
    });
  }

  // Cloud shadow cache
  const cache = snapshot.cloudShadowCache;
  if (cache && typeof cache === 'object') {
    const rawHitPct = Number(cache.rawHitPct) || 0;
    const rawMiss = Number(cache.rawMiss) || 0;
    if (rawHitPct < 5 && rawMiss > 100) {
      const reason = cache.lastMissReason ? ` (${cache.lastMissReason})` : '';
      insights.push({
        severity: 'warn',
        title: 'Cloud shadow cache cold',
        detail: `Raw shadow cache hit rate ${rawHitPct.toFixed(1)}% with ${rawMiss} misses${reason}. Hits rise when the view is stable (pause/pan); steady wind still advances motion buckets gradually.`,
        tags: ['cloud', 'cache'],
      });
    }
  }

  // Stutter / freeze classification
  const stutterAnalysis = snapshot.stutterSummary && snapshot.stutterEvents
    ? { summary: snapshot.stutterSummary, events: snapshot.stutterEvents, countsByKind: snapshot.stutterSummary.countsByKind ?? {} }
    : analyzeStutters(frames, ticks, {
      longTasks: snapshot.longTasks,
      spikeDetailsBySeq: buildSpikeDetailsMap(snapshot.spikeFrameDetails),
    });

  const stutterCounts = stutterAnalysis.countsByKind ?? {};
  const rafGapCount = stutterCounts.raf_gap ?? 0;
  const compositorSpikeCount = stutterCounts.compositor_spike ?? 0;
  const freezeCount = stutterCounts.freeze ?? 0;
  const presentGapCount = stutterCounts.present_gap ?? 0;
  const tickOverbudgetCount = stutterCounts.tick_overbudget ?? 0;

  if (rafGapCount > 0 && compositorSpikeCount === 0 && freezeCount === 0) {
    const rafP95 = stutterAnalysis.summary?.rafGapMs?.p95 ?? 0;
    const frameP95 = Number(session.frameTime?.p95) || 0;
    const eventLines = formatStutterEventLines(stutterAnalysis).join('; ');
    const gpuBound = snapshot.frameBudget?.diagnosis === 'gpu_bound_presentation';
    insights.push({
      severity: rafP95 >= 50 ? 'critical' : 'warn',
      title: gpuBound
        ? 'rAF gaps with healthy compositor CPU (GPU-bound pacing)'
        : 'Idle rAF stalls detected (compositor looks healthy)',
      detail: gpuBound
        ? `${rafGapCount} rAF gap(s), compositor p95 ${fmtMs(frameP95)} ms, but present spacing p50 ${fmtMs(snapshot.frameBudget?.presentP50Ms ?? 0)} ms. GPU work (see frameBudget) is likely limiting refresh, not main-thread CPU. Worst: ${eventLines || 'see stutter timeline'}.`
        : `${rafGapCount} rAF gap(s), compositor p95 ${fmtMs(frameP95)} ms. Main-thread work outside the compositor draw is the likely cause. Worst: ${eventLines || 'see stutter timeline'}.`,
      tags: gpuBound ? ['stutter', 'raf_gap', 'gpu', 'frameBudget'] : ['stutter', 'raf_gap', 'main-thread'],
    });
  } else if (freezeCount > 0) {
    const eventLines = formatStutterEventLines(stutterAnalysis).join('; ');
    insights.push({
      severity: 'critical',
      title: `${freezeCount} freeze(s) detected`,
      detail: `Gap exceeded 500 ms between rAF ticks. ${eventLines || 'See stutter timeline export.'}`,
      tags: ['stutter', 'freeze'],
    });
  }

  const presentP95 = stutterAnalysis.summary?.sinceLastPresentMs?.p95 ?? 0;
  const targetFps = Number(meta.context?.targetFps) || 60;
  const presentBudget = (1000 / Math.max(1, targetFps)) * 2;
  if (presentGapCount > 0 && presentP95 > presentBudget) {
    insights.push({
      severity: 'warn',
      title: 'Present spacing irregular',
      detail: `${presentGapCount} present gap(s); since-last-present p95 ${fmtMs(presentP95)} ms (target ~${fmtMs(1000 / targetFps)} ms interval). May feel like microstutter even when compositor frame time is low.`,
      tags: ['stutter', 'present_gap', 'pacing'],
    });
  }

  if (compositorSpikeCount > 0) {
    const threshold = stutterAnalysis.summary?.compositorSpikeThresholdMs ?? 20;
    const eventLines = formatStutterEventLines(
      { ...stutterAnalysis, events: stutterAnalysis.events.filter((e) => e.kind === 'compositor_spike') },
    ).join('; ');
    insights.push({
      severity: compositorSpikeCount >= 3 ? 'critical' : 'warn',
      title: `${compositorSpikeCount} compositor spike(s) above ${fmtMs(threshold)} ms`,
      detail: `${eventLines || 'See stutter timeline.'} Inspect top effect spans on those frames.`,
      tags: ['stutter', 'compositor_spike', 'spikes'],
    });
  }

  if (tickOverbudgetCount > 0) {
    const overPct = Number(session.pacing?.overBudgetPresentPct) || 0;
    insights.push({
      severity: overPct > 5 ? 'warn' : 'info',
      title: `${tickOverbudgetCount} over-budget rAF tick(s)`,
      detail: `${tickOverbudgetCount} presented tick(s) exceeded 34 ms (${overPct.toFixed(1)}% of presented ticks). Full handler cost, not just compositor.`,
      tags: ['stutter', 'tick_overbudget'],
    });
  }

  const longTasks = snapshot.longTasks ?? [];
  const longTasksOnGaps = stutterAnalysis.events.filter((e) => e.longTasks?.length).length;
  if (longTasks.length > 0) {
    const maxLt = longTasks.reduce((m, lt) => Math.max(m, lt.durationMs ?? 0), 0);
    insights.push({
      severity: maxLt >= 100 ? 'warn' : 'info',
      title: `${longTasks.length} long task(s) captured`,
      detail: `${longTasksOnGaps} stutter event(s) overlap a long task. Longest ${fmtMs(maxLt)} ms. Check Foundry hooks, GC, or other modules during idle stalls.`,
      tags: ['longtask', 'main-thread'],
    });
  }

  if (rafGapCount === 0 && compositorSpikeCount === 0 && freezeCount === 0 && presentGapCount === 0) {
    const avgFrame = Number(session.frameTime?.avg) || 0;
    if (avgFrame > 0 && avgFrame <= 16.7) {
      insights.push({
        severity: 'info',
        title: 'No stutter events in capture',
        detail: 'No rAF gaps, present gaps, compositor spikes, or freezes exceeded thresholds. If hitches were felt, re-record immediately after one occurs.',
        tags: ['stutter', 'session'],
      });
    }
  }

  // Presentation pacing (intentional gate vs real irregularity)
  if (pacingAnalysis && pacingAnalysis.diagnosis !== 'insufficient_data') {
    const pa = pacingAnalysis;
    const gatePct = pa.skip?.byReason?.presentation_gate?.pct ?? pa.gateSharePct ?? 0;
    const flips = pa.presentSkipFlipsPerSec ?? 0;
    const severity = pa.diagnosis === 'healthy_intentional_gating'
      ? 'info'
      : (pa.diagnosis === 'unexpected_skips' ? 'warn' : 'warn');
    insights.push({
      severity,
      title: pa.diagnosis === 'healthy_intentional_gating'
        ? 'Presentation pacing is gating rAF ticks (expected)'
        : 'Presentation pacing needs review',
      detail: [
        pa.note,
        `Skipped ${(pa.actualSkipPct ?? 0).toFixed(1)}% of rAF ticks (${gatePct.toFixed(0)}% presentation_gate).`,
        `~${pa.presentedFpsApprox ?? '?'} compositor presents/s at ~${pa.rafHz ?? '?'} Hz rAF.`,
        `Present/skip flips ${flips.toFixed(1)}/s are cadence changes, not hitches — use Stutter timeline present_gap for felt judder.`,
      ].filter(Boolean).join(' '),
      tags: ['pacing', 'presentation_gate', pa.diagnosis],
    });

    if (pa.diagnosis === 'healthy_intentional_gating' && (pa.actualSkipPct ?? 0) >= 50) {
      insights.push({
        severity: 'info',
        title: 'High skip % is not a compositor defect',
        detail: `Target ${pa.targetFps?.median ?? '?'} fps tier yields ~${pa.expectedSkipPct ?? '?'}% expected skip on ~${pa.rafHz ?? '?'} Hz. `
          + 'Weather/fire continuous effects use the presentation tier (often 30 fps). Idle scenes use 15 fps. '
          + 'Only investigate if present_gap stutters appear or skip reasons include strict_hold/composer_error.',
        tags: ['pacing', 'education'],
      });
    }
  }

  const targetFpsSet = new Set();
  for (const t of ticks ?? []) {
    if (t && Number(t.targetFps) > 0) targetFpsSet.add(Number(t.targetFps));
  }
  if (targetFpsSet.size > 1) {
    const tiers = [...targetFpsSet].sort((a, b) => a - b).join(' / ');
    const flips = pacingAnalysis?.presentSkipFlipsPerSec
      ?? (Number(session.pacing?.presentSkipFlipsPerSec ?? session.pacing?.judderPerSec) || 0);
    insights.push({
      severity: 'info',
      title: 'Adaptive target FPS transitions',
      detail: `Presentation tier switched between ${tiers} fps during capture. Present/skip cadence flips: ${flips.toFixed(1)}/s (not the same as visible stutter).`,
      tags: ['pacing', 'targetFps'],
    });
  }

  // V2 pass timing hints
  const passes = snapshot.v2PassTimings ?? {};
  const passList = Object.entries(passes)
    .map(([name, data]) => ({ name, avg: Number(data?.avg) || 0, total: Number(data?.total) || 0 }))
    .filter((p) => p.avg > 0.5)
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 3);
  if (passList.length > 0) {
    const list = passList.map((p) => `${p.name} ${fmtMs(p.avg)} ms avg`).join('; ');
    insights.push({
      severity: passList[0].avg > 3 ? 'warn' : 'info',
      title: 'Heaviest compositor passes',
      detail: list,
      tags: ['v2PassTimings'],
    });
  }

  // Frame budget summary
  const avgFrame = Number(session.frameTime?.avg) || 0;
  const avgFps = Number(session.fps?.avg) || 0;
  if (avgFrame > 0) {
    const overBudget = avgFrame > 16.7;
    insights.push({
      severity: overBudget ? 'warn' : 'info',
      title: 'Session frame budget',
      detail: `Avg ${fmtMs(avgFrame)} ms/frame (~${avgFps.toFixed(0)} fps), p95 ${fmtMs(session.frameTime?.p95 ?? 0)} ms, max ${fmtMs(session.frameTime?.max ?? 0)} ms.`,
      tags: ['session'],
    });
  }

  const frameBudget = snapshot.frameBudget;
  if (frameBudget && typeof frameBudget === 'object') {
    if (frameBudget.diagnosis === 'gpu_bound_presentation') {
      const top = frameBudget.primaryBottleneck ?? 'unknown span';
      insights.push({
        severity: 'critical',
        title: 'GPU-bound presentation (compositor CPU looks healthy)',
        detail: `Compositor CPU p95 ${fmtMs(frameBudget.compositorCpuP95Ms)} ms but present interval p50 ${fmtMs(frameBudget.presentP50Ms)} ms (~${frameBudget.achievedPresentFps?.toFixed?.(0) ?? '?'} fps). Sampled render GPU ~${fmtMs(frameBudget.sampledGpuAvgMs)} ms/frame; heaviest span: ${top}. Reduce that pass or lower presentation FPS while continuous effects are active.`,
        tags: ['gpu', 'pacing', 'frameBudget'],
      });
    } else if (frameBudget.diagnosis === 'compositor_cpu_bound') {
      insights.push({
        severity: 'warn',
        title: 'Compositor CPU over budget',
        detail: `Compositor CPU p95 ${fmtMs(frameBudget.compositorCpuP95Ms)} ms exceeds target interval ${fmtMs(frameBudget.targetIntervalMs)} ms. Inspect top CPU spans in the effect table.`,
        tags: ['cpu', 'frameBudget'],
      });
    }

    const topGpu = frameBudget.topGpuRenderSpans?.[0];
    if (topGpu && topGpu.gpuAvg >= 3) {
      insights.push({
        severity: topGpu.gpuAvg >= 5 ? 'warn' : 'info',
        title: 'Heaviest GPU render span',
        detail: `${topGpu.effect} ~${fmtMs(topGpu.gpuAvg)} ms GPU avg (max ${fmtMs(topGpu.gpuMax)} ms). See export \`frameBudget.topGpuRenderSpans\` for the full ranked list.`,
        tags: ['gpu', 'frameBudget'],
      });
    }
  }

  // Draw calls per frame (when fixed)
  const avgDraws = Number(session.avgDrawCallsPerFrame) || 0;
  if (avgDraws > 0) {
    insights.push({
      severity: 'info',
      title: 'Draw load',
      detail: `~${Math.round(avgDraws)} draw calls and ~${Math.round(session.avgTrianglesPerFrame ?? 0)} triangles per compositor frame (summed from render spans).`,
      tags: ['draws'],
    });
  }

  const lighting = snapshot.lighting;
  if (lighting && typeof lighting === 'object') {
    const wrapGpu = Number(lighting.totals?.compositorWrap?.render?.gpuAvg) || 0;
    const wrapCpu = Number(lighting.totals?.compositorWrap?.render?.cpuAvg) || 0;
    if (wrapGpu > 5 || wrapCpu > 0.5) {
      const share = lighting.frameBudgetHint?.compositorWrapGpuShareOfFramePct;
      const shareTxt = share != null ? ` (~${share.toFixed(0)}% of avg frame time as GPU)` : '';
      insights.push({
        severity: wrapGpu > 8 ? 'warn' : 'info',
        title: 'Lighting compositor wrap cost',
        detail: `FloorCompositor lighting/render avg ${fmtMs(wrapCpu)} ms CPU, ${fmtMs(wrapGpu)} ms GPU${shareTxt}. See export \`lighting.spans\` for sub-passes (composeDraw, lightSourcesDraw, foundryDraw, …).`,
        tags: ['lighting', 'gpu', 'effects'],
      });
    }

    const topLightingSpans = (lighting.spans ?? buildLightingSpanRows(effects, { cap: 3 }))
      .filter((s) => String(s.span).startsWith('lighting.'))
      .slice(0, 3);
    if (topLightingSpans.length > 0) {
      const list = topLightingSpans
        .map((s) => `${s.span} cpu ${fmtMs(s.cpuTotal)} gpu ${fmtMs(s.gpuTotal)}`)
        .join('; ');
      insights.push({
        severity: 'info',
        title: 'Heaviest lighting sub-spans',
        detail: list,
        tags: ['lighting', 'spans'],
      });
    }

    const blocked = Number(lighting.gpuCoverage?.blockedSamples) || 0;
    if (blocked > 100) {
      insights.push({
        severity: 'warn',
        title: 'Lighting GPU probes partially blocked',
        detail: `${blocked} blocked nested span sample(s). Prefer \`lighting.totals.compositorWrap.render\` GPU or \`lighting.passes\` (perLevel_lighting_*) for budgeting.`,
        tags: ['lighting', 'gpu', 'coverage'],
      });
    }

    const live = lighting.live ?? {};
    const counts = live.sourceCounts ?? {};
    const lightCount = Number(counts.foundryLights) || 0;
    if (lightCount > 80) {
      insights.push({
        severity: 'warn',
        title: 'High Foundry light count',
        detail: `${lightCount} synced lights (${counts.visibleLights ?? '?'} visible this frame). Light mesh draws scale with visible count — check Levels visibility and cull distant sources.`,
        tags: ['lighting', 'sources'],
      });
    }

    const estMb = Number(live.estimatedRtVramMb) || 0;
    const lightScale = Number(live.resolutionScales?.internalLightResolutionScale) || 1;
    if (estMb > 48 || lightScale < 0.75) {
      insights.push({
        severity: estMb > 80 ? 'warn' : 'info',
        title: 'Lighting RT footprint',
        detail: `~${estMb.toFixed(1)} MB estimated across lighting RTs at scale ${lightScale.toFixed(2)} (light/window/darkness). Lower internalLightResolutionScale to trade quality for bandwidth.`,
        tags: ['lighting', 'vram'],
      });
    }

    const prepassPct = live.sessionCounters?.prepassReusePct;
    if (prepassPct != null && prepassPct > 10) {
      insights.push({
        severity: 'info',
        title: 'Light mask prepass reuse',
        detail: `Foundry light RT redraw skipped on ${prepassPct.toFixed(1)}% of compose draws (shadow prepass still fresh).`,
        tags: ['lighting', 'cache'],
      });
    }
  }

  const worldOverlays = snapshot.worldOverlays;
  if (worldOverlays && typeof worldOverlays === 'object') {
    const rollup = worldOverlays.gpuRollup;
    const topGpu = (worldOverlays.spans ?? buildWorldOverlaysSpanRows(effects, { cap: 8 }))
      .filter((s) => (s.gpuAvg ?? 0) > 0 && String(s.span).includes('.draw.'))
      .slice(0, 3);
    if (rollup?.estimatedOverlayGpuAvgMs >= 4 || topGpu.length > 0) {
      const drawList = topGpu.length > 0
        ? topGpu.map((s) => `${s.span} ~${fmtMs(s.gpuAvg)} ms GPU`).join('; ')
        : `estimated ~${fmtMs(rollup?.estimatedOverlayGpuAvgMs)} ms/frame`;
      insights.push({
        severity: (rollup?.estimatedOverlayGpuAvgMs ?? 0) >= 6 ? 'warn' : 'info',
        title: 'Post-bloom world overlay GPU',
        detail: `${drawList}. Splashes ~${fmtMs(rollup?.splashesGpuAvgMs ?? 0)} ms; vegetation draw ~${fmtMs(rollup?.vegetationDrawGpuAvgMs ?? 0)} ms. See export \`worldOverlays.spans\` and \`worldOverlays.live.byKind\`.`,
        tags: ['gpu', 'worldOverlays', 'vegetation'],
      });
    }

    const blocked = Number(worldOverlays.gpuCoverage?.blockedSamples) || 0;
    if (blocked > 20) {
      insights.push({
        severity: 'warn',
        title: 'World overlay GPU probes partially blocked',
        detail: `${blocked} blocked sample(s) — parent span may still be holding the GPU timer. Re-export after reload; parent \`postBloom.worldOverlays\` should be cpuOnly.`,
        tags: ['worldOverlays', 'gpu', 'coverage'],
      });
    }

    const live = worldOverlays.live ?? {};
    const rootCount = Number(live.vegetationRootCount) || 0;
    if (rootCount > 0 && (rollup?.vegetationDrawGpuAvgMs ?? 0) >= 3) {
      const kinds = live.byKind ?? {};
      insights.push({
        severity: 'info',
        title: 'Vegetation overlay inventory',
        detail: `${rootCount} draw roots (bush shadow/canopy ${kinds.bush?.shadow ?? 0}/${kinds.bush?.canopy ?? 0}, tree ${kinds.tree?.shadow ?? 0}/${kinds.tree?.canopy ?? 0}) at ${live.drawingBuffer?.w ?? '?'}×${live.drawingBuffer?.h ?? '?'} buffer.`,
        tags: ['worldOverlays', 'vegetation'],
      });
    }
  }

  const weatherSpans = snapshot.weatherParticles?.spans
    ?? buildWeatherSpanRows(effects, { cap: 6 });
  if (weatherSpans.length > 0) {
    const top = weatherSpans[0];
    const topCpu = Number(top.cpuTotal) || 0;
    const live = snapshot.weatherParticles?.live ?? {};
    const precip = Number(live.precipitation) || 0;
    const ash = Number(live.ashIntensity) || 0;
    const list = weatherSpans.slice(0, 3)
      .map((s) => `${s.span} ${fmtMs(s.cpuTotal)} ms`)
      .join('; ');
    if (topCpu >= 2 || precip > 0.05 || ash > 0.05) {
      insights.push({
        severity: topCpu >= 6 ? 'warn' : 'info',
        title: 'Weather particles update cost',
        detail: `${list}. Live precip ${precip.toFixed(2)}, ash ${ash.toFixed(2)}, `
          + `${live.batchSystems ?? '?'} quarks systems, ${live.culledSystems ?? 0} culled. `
          + 'Heaviest step is usually `weatherParticles.update.quarks` or `particles` during rain.',
        tags: ['weather', 'particles', 'cpu'],
      });
    }
    if (live.wantsContinuousRender === true && precip > 0.05) {
      insights.push({
        severity: 'info',
        title: 'Weather driving continuous render',
        detail: 'Active precipitation locks the compositor on its continuous path — expect adaptive 30 fps tiers while rain/ash is visible.',
        tags: ['weather', 'continuous', 'pacing'],
      });
    }
  }

  const windowSpans = snapshot.windowLight?.spans
    ?? buildWindowLightSpanRows(effects, { cap: 6 });
  if (windowSpans.length > 0) {
    const topRender = windowSpans.find((s) => s.phase === 'render') ?? null;
    const topUpdate = windowSpans.find((s) => s.phase === 'update') ?? null;
    const renderCpu = Number(topRender?.cpuTotal) || 0;
    const renderGpu = Number(topRender?.gpuTotal) || 0;
    const updateCpu = Number(topUpdate?.cpuTotal) || 0;
    const live = snapshot.windowLight?.live ?? {};
    const skipped = Number(live.sessionCounters?.skippedFullDraws) || 0;
    const fullDraws = Number(live.sessionCounters?.fullDraws) || 0;
    const parts = [];
    if (topRender) {
      parts.push(`${topRender.span} cpu ${fmtMs(topRender.cpuTotal)} gpu ${fmtMs(topRender.gpuTotal)}`);
    }
    if (topUpdate && topUpdate !== topRender) {
      parts.push(`${topUpdate.span} cpu ${fmtMs(topUpdate.cpuTotal)}`);
    }
    if (renderCpu + renderGpu + updateCpu >= 1) {
      const cacheNote = (skipped > 0 && fullDraws > 0)
        ? ` Emit cache skipped ${skipped}/${skipped + fullDraws} full draws.`
        : '';
      insights.push({
        severity: (renderGpu >= 4 || renderCpu >= 4) ? 'warn' : 'info',
        title: 'Window light sub-spans',
        detail: `${parts.join('; ')}.${cacheNote} GPU emit alternates with lighting.render.windowLightDraw (gpuSlot 0/2 vs 1/2).`,
        tags: ['windowLight', 'lighting'],
      });
    }
    if (Number(live.emitRt?.w) > 2048 || Number(live.emitRt?.h) > 2048) {
      insights.push({
        severity: 'info',
        title: 'Large window emit RT',
        detail: `Emit atlas ${live.emitRt?.w ?? '?'}×${live.emitRt?.h ?? '?'} at scale ${Number(live.emitRt?.scale ?? 1).toFixed(2)} — lower internal window resolution in lighting if emitDraw GPU is high.`,
        tags: ['windowLight', 'vram', 'gpu'],
      });
    }
  }

  return insights;
}

/**
 * Format insights as markdown bullet list.
 * @param {PerformanceInsight[]} insights
 * @returns {string}
 */
export function formatInsightsMarkdown(insights) {
  if (!insights?.length) return '_No insights._\n';
  const icon = { info: 'ℹ️', warn: '⚠️', critical: '🔴' };
  return insights.map((i) => {
    const prefix = icon[i.severity] ?? '•';
    return `- ${prefix} **${i.title}:** ${i.detail}`;
  }).join('\n') + '\n';
}
