/**
 * diag/load-report.js — THE LOADING-TIME REPORT BRAIN (mythica-machina-press#400).
 *
 * Pure, like `perf-report.js`: no clock, no DOM. Takes
 * `ui/loading-screen.js#getLoadingScreenState()`'s raw shape and produces the
 * one object worth pasting into a chat when a load feels slow or frozen —
 * every phase from the moment the module engages through to the warm-up hold,
 * a verdict on which one ate the majority of the time, and — for WARMING
 * specifically — which NAMED cause (streaming, GPU compression, shader/
 * pipeline compile, ...) was outstanding and for how long.
 *
 * ============================================================================
 * THREE SITUATIONS, NEVER CONFLATED
 * ============================================================================
 * `feedback_instruments_must_not_lie` (perf-report.js's own naming) applies
 * here just as much: nothing has ever loaded, a load is stuck RIGHT NOW, and
 * the last load already finished (cleanly, by timeout, or by error) are three
 * genuinely different situations. Each gets its own `status` rather than being
 * squeezed into one shape that would have to lie about which is true. The
 * in-progress case matters most for THIS report's whole reason to exist: the
 * author wants to know what is freezing, which usually means running this
 * while it is still frozen, not only after it recovers.
 *
 * @module diag/load-report
 */
import { LOAD_PHASES, PHASE_LABELS } from '../ui/index.js';
// Reused, not reinvented: cache-report.js already turns each subsystem's own
// bespoke stats shape into one comparable {hits,misses,hitRatePct,...} row and
// already refuses to fabricate a hit rate a cache cannot actually report — see
// that file's own header. Re-deriving that here would risk disagreeing with it.
import { buildCacheRows, findLowHitRateCaches } from './cache-report.js';

const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);

function pct(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * One phase span -> one report row. `totalMs` is the load's elapsed time (so
 * far, for an in-progress load) — used both for the percentage and, for the
 * one phase still open, to derive its running duration: a still-running span
 * has `durMs: null` in the raw model (nothing has closed it yet), and that is
 * exactly the phase most likely to be the freeze someone is asking about, so
 * it must not silently drop out of the ranking for want of a number.
 */
function buildPhaseRows(phaseSpans, totalMs) {
  return (phaseSpans || []).map((p) => {
    const stillRunning = p.endMs === null;
    const derivedMs =
      stillRunning && Number.isFinite(p.startMs) && Number.isFinite(totalMs) ? totalMs - p.startMs : null;
    const durMs = round(p.durMs !== null && p.durMs !== undefined ? p.durMs : derivedMs);
    return {
      id: p.phase,
      label: PHASE_LABELS[p.phase] ?? p.phase,
      startMs: round(p.startMs),
      endMs: round(p.endMs),
      durMs,
      stillRunning,
      pctOfTotal: durMs === null ? null : pct(durMs, totalMs),
      note: stillRunning ? 'still running — this duration is "so far", not final' : (p.note ?? null),
    };
  });
}

/**
 * Turn one phase's accumulated blocker-time bucket into a ranked breakdown.
 * `phaseDurMs` is the SAME phase row's own duration, used only for the
 * percentage — never assumed to equal the sum of entries, since overlapping
 * blockers make that sum routinely exceed the phase's own wall time.
 */
function buildBlockerBreakdown(bucket, phaseDurMs) {
  if (!bucket) return null;
  const entries = Object.entries(bucket)
    .map(([key, v]) => ({ key, label: v.label, ms: round(v.ms), pctOfPhase: pct(v.ms, phaseDurMs) }))
    .sort((a, b) => b.ms - a.ms);
  if (entries.length === 0) return null;
  return {
    entries,
    note:
      'Each entry is credited the FULL time it was reported outstanding, so entries can overlap — more than one ' +
      'thing can be blocking at once — and percentages are not required to sum to 100%. Resolution is bounded by ' +
      'how often readiness was polled while waiting, so read these as directional, not exact.',
  };
}

/**
 * The five art-streaming caches a cold load actually walks through — see
 * `cache-report.js`'s own `RAW_CACHE_ADAPTERS` for the full set this is
 * deliberately a NARROWER slice of (point-light/door/paint-mode pools have
 * nothing to do with a cold scene load, and would just be noise here).
 */
const ART_CACHE_IDS = new Set([
  'vtPageCache',
  'vtDecodePool',
  'compressedTextureWorker',
  'coarseAlphaGridRequests',
  'pyramidStore',
]);

/**
 * Cache hit/miss for THIS load specifically (mythica-machina-press#400,
 * author: "if something is being recalculated every load that doesn't need
 * to be, that would also cause slowdown"). `snapshot` is `{start, end}`, two
 * point-in-time reads of the same raw stats bracketing the load — cache-
 * report.js's own `buildCacheRows` already knows how to diff exactly this
 * shape, so this just calls it and keeps the five rows relevant to art
 * streaming, discarding whatever else it always constructs (point-light/
 * door/paint-mode pools) with no start/end data behind it.
 */
function buildCacheHealthSection(snapshot) {
  if (!snapshot?.start || !snapshot?.end) return null;
  const rows = buildCacheRows({ cacheStats: snapshot }).filter((r) => ART_CACHE_IDS.has(r.id));
  if (rows.length === 0) return null;
  const lowHitRate = findLowHitRateCaches(rows);
  return {
    rows,
    // Named, not just left for the reader to notice buried in `rows` — see
    // this file's own top-contributor rule: a verdict a tool can compute
    // must not be left as an exercise.
    lowHitRateCacheIds: lowHitRate.map((r) => r.id),
    note:
      'hits/misses are for THIS LOAD ONLY (a before/after snapshot around it), not lifetime totals. A cache with ' +
      'a low hit rate here, on a scene already visited before, is the "recomputing something that should have ' +
      'been cached" signature the author asked to watch for — see each row\'s own note for what hit/miss means ' +
      'for that specific cache (they are not all the same granularity, and some have no hits counter at all).',
  };
}

/**
 * One rebuild probe's stats() -> one report section. `skipped: true` (the
 * probe could not find what it needed to wrap, e.g. `renderer._pipelines`
 * moved) is a genuinely different fact from "armed and measured zero
 * misses" — collapsing them would let a broken probe read as a healthy load.
 */
function buildProbeSection(stats) {
  if (!stats) return null;
  if (stats.skipped === true) {
    return {
      measured: false,
      reason: stats.reason ?? 'not measured',
      misses: null,
      totalMs: null,
      worstMs: null,
      topLabels: [],
    };
  }
  return {
    measured: true,
    misses: Number.isFinite(stats.misses) ? stats.misses : 0,
    totalMs: Number.isFinite(stats.totalMissMs) ? round(stats.totalMissMs) : null,
    worstMs: Number.isFinite(stats.worstMissMs) ? round(stats.worstMissMs) : null,
    topLabels: (stats.labels ?? []).slice(0, 5),
  };
}

/**
 * Shader-graph rebuild + GPU pipeline compile time — the ONE measurement in
 * this whole report that survives a fully synchronous main-thread freeze
 * intact (mythica-machina-press#400 follow-up). Everything else here
 * (`warmingBreakdown` included) is built from POLLING `vt/settle.js` every
 * ~250ms, which requires the main thread to be free to check in at all; a
 * genuine multi-second block starves that poll (and the render-loop-driven
 * settle sampler it depends on) just as much as it starves the user. This
 * section instead brackets the two known-synchronous compile call sites
 * directly — a clock read immediately before and immediately after — so it
 * reports the truth even when nothing else could run in between.
 *
 * @param {{shaderRebuild:object, pipelineRebuild:object}|null} diagnostics
 * @param {number|null} worstStallMs - for the correlation note below.
 */
function buildCompileTimeSection(diagnostics, worstStallMs) {
  const shader = buildProbeSection(diagnostics?.shaderRebuild ?? null);
  const pipeline = buildProbeSection(diagnostics?.pipelineRebuild ?? null);
  if (!shader && !pipeline) return null;
  const shaderMs = shader?.measured ? shader.totalMs : null;
  const pipelineMs = pipeline?.measured ? pipeline.totalMs : null;
  const haveEither = shaderMs !== null || pipelineMs !== null;
  const combinedMs = haveEither ? round((shaderMs ?? 0) + (pipelineMs ?? 0)) : null;

  let correlationNote = null;
  if (combinedMs !== null && Number.isFinite(worstStallMs) && worstStallMs > 0) {
    const ratio = combinedMs / worstStallMs;
    correlationNote =
      ratio >= 0.7
        ? `This is close to (${Math.round(ratio * 100)}% of) the worst single main-thread stall recorded this ` +
          `load (${round(worstStallMs)}ms) — shader/pipeline compilation is a strong candidate for what caused it.`
        : ratio >= 0.2
          ? `This accounts for only ${Math.round(ratio * 100)}% of the worst single stall (${round(worstStallMs)}ms) ` +
            '— real, but likely not the whole story behind that stall.'
          : `This is small next to the worst single stall (${round(worstStallMs)}ms) — look elsewhere (bakes, ` +
            "decode bursts, mask readback) for that freeze's cause.";
  }

  return {
    shaderRebuild: shader,
    pipelineRebuild: pipeline,
    combinedMs,
    correlationNote,
    note:
      'Wall-clock time inside real shader-graph rebuilds and GPU pipeline compiles this load, timed with a clock ' +
      'read immediately before and after each one. If this total is large while `warmingBreakdown` above shows ' +
      'little or no "pipelineCompiles" time, that mismatch is itself informative, not a contradiction: it means ' +
      'the compile was long enough to block the very poll that would have caught it — this direct measurement is ' +
      'the one built to survive exactly that case.',
  };
}

/**
 * Real per-zone CPU/GPU cost during THIS load, straight off the SAME zone
 * profiler the steady-state performance report already uses — arming it for
 * one load's duration (boot.js) is the entire new instrumentation; the
 * formatting is `reckoning-report.js`'s own `summarizeZoneRows`, unchanged.
 *
 * Found via a real live capture (mythica-machina-press#400, Big Bank,
 * 2026-09-01): a load whose FIRST_FRAME phase alone took 33.5s, with an
 * 11.96s single main-thread stall inside it, while shader/pipeline compile
 * time measured only ~1.2s total. Something else was the other ~20s+ — this
 * section exists to name it (a bake, a residency pass, mask readback, ...)
 * rather than leaving that gap unattributed the way `compileTime` alone does.
 *
 * RANKED BY WORST SINGLE OCCURRENCE, not `summarizeZoneRows`'s own per-frame
 * average: that average is the right lens for a many-second steady-state
 * window, and the wrong one here — a bake that fires exactly once during a
 * cold load, divided by however few frames rendered in a mostly-frozen
 * window, is precisely the shape a per-frame mean hides (perf-report.js's
 * own `feedback_instruments_must_not_lie` rule about sparse vs steady cost).
 */
function buildZoneBreakdownSection(zoneRows) {
  if (!Array.isArray(zoneRows) || zoneRows.length === 0) return null;
  const ranked = zoneRows
    .map((r) => ({ ...r, worstMs: Math.max(r.gpuMaxMs ?? 0, r.cpuMaxMs ?? 0) }))
    .filter((r) => r.worstMs > 0)
    .sort((a, b) => b.worstMs - a.worstMs)
    .slice(0, 10);
  if (ranked.length === 0) return null;
  return {
    topZones: ranked,
    note:
      'Ranked by the SINGLE WORST occurrence (max CPU or GPU ms this load), not the per-frame average — a bake ' +
      'or one-time pass that fires once during a cold load is exactly what a steady-state average would hide. ' +
      'These are the same named zones (residency passes, per-effect bakes, ...) the steady-state performance ' +
      'report already declares; this is that same profiler, armed for one load instead of a fixed window.',
  };
}

/** Rank phases by duration and name the biggest one — a verdict a tool can compute must not be left as an exercise. */
function pickTopContributor(phaseRows) {
  const ranked = phaseRows.filter((p) => Number.isFinite(p.durMs)).sort((a, b) => b.durMs - a.durMs);
  if (ranked.length === 0) return null;
  const top = ranked[0];
  return {
    id: top.id,
    label: top.label,
    durMs: top.durMs,
    pctOfTotal: top.pctOfTotal,
    stillRunning: top.stillRunning,
    note:
      top.pctOfTotal !== null
        ? `"${top.label}" accounts for ${top.pctOfTotal}% of the whole load (${top.durMs}ms)${top.stillRunning ? ' so far' : ''} — the single biggest contributor.`
        : `"${top.label}" is the longest phase measured (${top.durMs}ms)${top.stillRunning ? ' so far' : ''}.`,
  };
}

/**
 * What "settled" (the end of WARMING, and of this whole timeline) actually
 * means, spelled out once so a reader of a pasted report is not left guessing
 * at the boundary. See `vt/settle.js` for the real rule — this is a pointer to
 * it, not a second copy: nothing here needs to agree with a number it never
 * declares.
 */
const METHODOLOGY =
  '"Settled" (the end of WARMING) means: nothing outstanding, held quiet for a settle window, real frames ' +
  'rendering during that window, and no shader/pipeline compile or frame-time hitch inside it either (see ' +
  'vt/settle.js). That already requires a run of good frames before declaring done, not just one clean instant.';

/**
 * @param {ReturnType<typeof import('../ui/loading-screen.js').getLoadingScreenState>} loadingScreenState
 * @param {{shaderRebuild?:object, pipelineRebuild?:object, cacheSnapshot?:{start:object,end:object}}|null} [diagnostics] -
 *   the arm/disarm bracket `boot.js` gathers around the SAME load this
 *   report describes (mythica-machina-press#400 follow-up). Optional and
 *   separate from `loadingScreenState` deliberately: it is orthogonal to
 *   phase timing (load-progress.js's own job) and gathered by a different
 *   part of boot.js (the rebuild probes + cache getters), not something the
 *   phase-timing model should have to know exists.
 * @returns {object}
 */
export function buildLoadReport(loadingScreenState, diagnostics = null) {
  const state = loadingScreenState ?? {};
  const report = { report: 'loading-time', generatedAt: new Date().toISOString(), methodology: METHODOLOGY };

  if (state.showing && state.current) {
    const totalMs = round(state.current.elapsedMs);
    const phaseRows = buildPhaseRows(state.currentPhases, totalMs);
    const warmingRow = phaseRows.find((p) => p.id === LOAD_PHASES.WARMING);
    const worstStallMs = Number.isFinite(state.currentWorstStallMs) ? state.currentWorstStallMs : null;
    report.status = 'in-progress';
    report.note =
      'A scene load is running RIGHT NOW. Every duration below is "elapsed so far", not final — the open phase ' +
      '(stillRunning: true) is the one still running, and is almost always where a freeze is happening.';
    report.elapsedMsSoFar = totalMs;
    report.currentPhaseLabel = state.current.title ?? null;
    report.stallNote = state.current.stallNote ?? null;
    report.worstStallMsSoFar = worstStallMs === null ? null : round(worstStallMs);
    report.blockers = state.current.blockers ?? [];
    report.phases = phaseRows;
    report.topContributorSoFar = pickTopContributor(phaseRows);
    report.warmingBreakdownSoFar = buildBlockerBreakdown(
      state.currentBlockerDurationsMs?.[LOAD_PHASES.WARMING],
      warmingRow?.durMs ?? null
    );
    // Compile time reads LIVE here (boot.js passes a fresh, non-destructive
    // probe read for an in-flight load, not last load's disarmed stats) —
    // arming a probe never needs to stop mid-load to be READ mid-load.
    // Cache health and the zone breakdown are NOT yet wired for a live read
    // (both need a "since this load's own start" baseline boot.js does not
    // yet expose while still in flight) — absent here rather than showing a
    // previous load's numbers mislabelled as this one's.
    report.compileTime = buildCompileTimeSection(diagnostics, worstStallMs);
    report.cacheHealth = buildCacheHealthSection(diagnostics?.cacheSnapshot ?? null);
    report.zoneBreakdown = null;
  } else if (state.lastLoad) {
    const last = state.lastLoad;
    const totalMs = round(last.totalMs);
    const phaseRows = buildPhaseRows(last.phases, totalMs);
    const warmingRow = phaseRows.find((p) => p.id === LOAD_PHASES.WARMING);
    report.status = last.error ? 'failed' : last.forcedReveal ? 'forced-reveal' : 'complete';
    report.sceneName = last.sceneName ?? null;
    report.totalMs = totalMs;
    report.error = last.error ?? null;
    report.forcedReveal = !!last.forcedReveal;
    report.unfinishedWhenRevealed = last.unfinished ?? [];
    report.worstStallMs = round(last.worstStallMs);
    report.worstStallNote =
      last.worstStallMs > 0
        ? `The main thread froze for as long as ${round(last.worstStallMs)}ms at some point during this load — a ` +
          'load that completes but stalled is a bug with a receipt, not a clean success.'
        : null;
    report.phases = phaseRows;
    report.topContributor = pickTopContributor(phaseRows);
    report.warmingBreakdown = buildBlockerBreakdown(
      last.blockerDurationsMs?.[LOAD_PHASES.WARMING],
      warmingRow?.durMs ?? null
    );
    report.compileTime = buildCompileTimeSection(diagnostics, report.worstStallMs);
    report.cacheHealth = buildCacheHealthSection(diagnostics?.cacheSnapshot ?? null);
    // Zone breakdown is COMPLETED-LOAD ONLY — see the in-progress branch's own
    // comment on why compile time reads live there but this does not (yet).
    report.zoneBreakdown = buildZoneBreakdownSection(diagnostics?.zoneRows ?? null);
  } else {
    report.status = 'no-data';
    report.note =
      'No scene load has been recorded yet this session — switch scenes (or reload) once, then run this again.';
  }

  return report;
}
