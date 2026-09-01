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
 * @returns {object}
 */
export function buildLoadReport(loadingScreenState) {
  const state = loadingScreenState ?? {};
  const report = { report: 'loading-time', generatedAt: new Date().toISOString(), methodology: METHODOLOGY };

  if (state.showing && state.current) {
    const totalMs = round(state.current.elapsedMs);
    const phaseRows = buildPhaseRows(state.currentPhases, totalMs);
    const warmingRow = phaseRows.find((p) => p.id === LOAD_PHASES.WARMING);
    report.status = 'in-progress';
    report.note =
      'A scene load is running RIGHT NOW. Every duration below is "elapsed so far", not final — the open phase ' +
      '(stillRunning: true) is the one still running, and is almost always where a freeze is happening.';
    report.elapsedMsSoFar = totalMs;
    report.currentPhaseLabel = state.current.title ?? null;
    report.stallNote = state.current.stallNote ?? null;
    report.blockers = state.current.blockers ?? [];
    report.phases = phaseRows;
    report.topContributorSoFar = pickTopContributor(phaseRows);
    report.warmingBreakdownSoFar = buildBlockerBreakdown(
      state.currentBlockerDurationsMs?.[LOAD_PHASES.WARMING],
      warmingRow?.durMs ?? null
    );
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
  } else {
    report.status = 'no-data';
    report.note =
      'No scene load has been recorded yet this session — switch scenes (or reload) once, then run this again.';
  }

  return report;
}
