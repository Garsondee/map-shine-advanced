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
      '⚠️ WINDOW CAVEAT FIRST (mythica-machina-press#583): the "before" snapshot is taken AFTER ' +
      '`startRealSceneViewer()` has already resolved — so this window EXCLUDES the entire fetch → decode → ' +
      'BC-compress chain, which all runs inside that call. That is the very chain these counters describe. An ' +
      'all-zero row here therefore means "not measured", NOT "this cache was never used", and must not be read ' +
      'as evidence that persistence is failing between sessions. ' +
      'Within that (post-streaming) window, hits/misses are for THIS LOAD ONLY (a before/after snapshot around ' +
      'it), not lifetime totals. A cache with a genuinely low hit rate here, on a scene already visited before, ' +
      'is the "recomputing something that should have been cached" signature the author asked to watch for — ' +
      "see each row's own note for what hit/miss means for that specific cache (they are not all the same " +
      'granularity, and some have no hits counter at all).',
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
 * BACKGROUND TIME — how much of this load the tab spent hidden
 * (mythica-machina-press#582).
 *
 * Reported as its own line rather than quietly subtracted from `totalMs`,
 * because both numbers are true and they answer different questions: wall time
 * is what the person experienced, active time is what the engine actually had.
 * Silently netting them would hide a real fact (the user waited that long);
 * silently ignoring them — which is what this report did until now — bills
 * seconds of a stopped browser to whichever phase happened to be open, and is
 * the single most plausible explanation for a 25.7s `firstFrame` phase whose
 * entire body is `await rAF(rAF)`.
 *
 * @param {number|null} hiddenMs @param {number|null} totalMs
 */
function buildBackgroundSection(hiddenMs, totalMs) {
  if (!Number.isFinite(hiddenMs) || hiddenMs <= 0) return null;
  const pct = Number.isFinite(totalMs) && totalMs > 0 ? Math.round((hiddenMs / totalMs) * 100) : null;
  return {
    hiddenMs: round(hiddenMs),
    pctOfTotal: pct,
    activeMs: Number.isFinite(totalMs) ? round(Math.max(0, totalMs - hiddenMs)) : null,
    note:
      'This tab was in the BACKGROUND for ' +
      `${round(hiddenMs)}ms of this load${pct === null ? '' : ` (${pct}% of it)`}. Browsers stop ` +
      'requestAnimationFrame entirely for a hidden tab, so during that time no frame rendered, no liveness ' +
      'tick ran, and the engine made no progress — but the load clock kept counting. Subtract it before ' +
      'concluding anything about which phase is slow: a phase that "took" 25s with the tab hidden for 20 of ' +
      'them took 5.',
  };
}

/**
 * TEXTURE COMPRESSION HEALTH (mythica-machina-press#585) — "did any layer end
 * up as a RAW texture, and what did that cost?"
 *
 * When the BC worker is unavailable or failing, `requestCompressedTexture`
 * resolves `null` and the caller falls back to an uncompressed texture. On a
 * 12,000-square layer that is ~576MB instead of ~144MB, uploaded on the main
 * thread — which makes it a prime suspect for a single multi-second stall
 * inside the first frame, the one thing in the live reports nothing has ever
 * attributed.
 *
 * A POINT-IN-TIME read at load end, NOT a before/after delta — so #583's
 * window defect cannot apply here. Stated in the note, because a reader who has
 * just been told to distrust `cacheHealth`'s window is entitled to know why
 * this one is different rather than having to assume it.
 */
function buildCompressionSection(c) {
  if (!c) return null;
  const w = c.worker ?? null;
  const items = Array.isArray(c.items) ? c.items : [];
  // "fell back" = the per-item field says so explicitly. Anything else is left
  // out rather than inferred: `null` there means "not reported", and guessing
  // a fallback from an absent field is how an instrument starts inventing.
  const fellBack = items.filter((i) => typeof i.compressed === 'string' && /error|fellback/i.test(i.compressed));
  const workerBroken = !!(w && (w.unavailable === true || (w.failed ?? 0) > 0 || w.workerCreated === false));
  return {
    workerCreated: w?.workerCreated ?? null,
    unavailable: w?.unavailable ?? null,
    cooldownActive: w?.cooldownActive ?? null,
    consecutiveWorkerFailures: w?.consecutiveWorkerFailures ?? null,
    requests: w?.requests ?? null,
    failed: w?.failed ?? null,
    cached: w?.cached ?? null,
    applied: c.applied ?? null,
    appliedItems: c.appliedItems ?? null,
    itemCount: c.itemCount ?? null,
    estTextureVramMB: c.estTextureVramMB ?? null,
    fellBackItemIds: fellBack.map((i) => i.id).filter(Boolean),
    note: workerBroken
      ? 'THE GPU TEXTURE-COMPRESSION WORKER IS NOT HEALTHY. Every layer it could not compress is held as a RAW ' +
        'texture instead — roughly 4x the bytes of BC7, uploaded on the main thread. On a 12,000-square map that ' +
        'is the difference between ~144MB and ~576MB for a single layer. If this load showed one long ' +
        'unexplained freeze, this is the first thing to rule in or out.'
      : fellBack.length > 0
        ? `${fellBack.length} layer(s) fell back to a RAW texture even though the worker reports healthy — check ` +
          'fellBackItemIds. A raw 12,000-square layer is ~576MB against ~144MB compressed.'
        : 'Compression worker reports healthy and no layer is recorded as having fallen back to a raw texture. ' +
          'This is a POINT-IN-TIME read at load end, not a before/after delta, so the #583 window caveat that ' +
          'applies to cacheHealth does NOT apply here.',
  };
}

/**
 * THE WARM-UP'S OWN OUTCOME — did the one mechanism built to move compilation
 * behind the curtain actually run? (mythica-machina-press#582)
 *
 * `warmUpDrawState` catches its own exceptions and sets `warmUpMs = null`,
 * deliberately: warming is an optimisation and must never fail a load. But that
 * swallow means a warm-up which throws on its FIRST pass — compiling nothing at
 * all, leaving every pipeline to compile lazily in front of the user — is
 * indistinguishable, from every report this module produced, from one that
 * worked perfectly. That is not hypothetical: mythica-machina-press#402 is
 * exactly that failure, it fired on literally every scene load, and it was
 * triaged as "purely cosmetic" precisely because nothing measured it.
 *
 * So the outcome is reported, and a failure is called a failure. `null` here is
 * "it ran and threw", NOT "no data" — the two are worded so they can never be
 * read as each other ([[feedback_absent_zone_row_is_a_measurement]]).
 *
 * @param {{warmUpMs?:number|null, warmUpPipelinesCreated?:number|null,
 *   shaderCompileMs?:number|null}|null} warmUp
 */
function buildWarmUpSection(warmUp) {
  if (!warmUp) return null;
  const ran = Number.isFinite(warmUp.warmUpMs);
  const created = Number.isFinite(warmUp.warmUpPipelinesCreated) ? warmUp.warmUpPipelinesCreated : null;
  // THE UNPAUSE FIX'S OWN RECEIPT (mythica-machina-press#582), reported
  // separately from the draw warm-up's count on purpose — see
  // `warmUpSimPipelinesCreated`'s declaration for why one combined total would
  // make the claim unfalsifiable.
  const simCreated = Number.isFinite(warmUp.warmUpSimPipelinesCreated) ? warmUp.warmUpSimPipelinesCreated : null;
  return {
    ran,
    ms: ran ? round(warmUp.warmUpMs) : null,
    pipelinesCreated: created,
    simPipelinesCreated: simCreated,
    // THE CAUSE, not just the fact (mythica-machina-press#584). A warm-up that
    // threw is only actionable if it says what threw — otherwise the report
    // reproduces the exact shrug that let #402 sit misfiled for weeks.
    error: warmUp.warmUpError ?? null,
    simError: warmUp.warmUpSimError ?? null,
    simNote:
      simCreated === null
        ? 'Sim-kernel warm-up was not measured on this load.'
        : simCreated > 0
          ? `${simCreated} compute pipeline(s) for the particle/gust/fire/rain kernels were compiled BEHIND the ` +
            'curtain. These are the ones that used to compile the first time the world was unpaused — this is ' +
            'the unpause freeze being paid for while the curtain is still up.'
          : 'The sim warm-up created NO compute pipelines. Either they were already compiled (a revisit), or ' +
            'warmUpSims() reached nothing — in which case the unpause freeze should be expected to persist, and ' +
            'this zero is the evidence rather than a silent nothing-happened.',
    shaderPrecompileMs: Number.isFinite(warmUp.shaderCompileMs) ? round(warmUp.shaderCompileMs) : null,
    note: ran
      ? created === 0
        ? 'The warm-up draw ran but created NO new pipelines. Either everything was already compiled (a warm ' +
          'cache — normal on a revisit), or the pass plan never reached the passes that would have compiled ' +
          'something. Compare against a genuinely cold load before concluding.'
        : 'The warm-up draw ran and compiled pipelines behind the curtain, which is where they are supposed to ' +
          'compile — this is the mechanism working.'
      : 'THE WARM-UP DRAW DID NOT COMPLETE. It threw and was swallowed (by design — warming must never fail a ' +
        'load), which means every pipeline it would have compiled is instead compiling lazily on its first real ' +
        'draw, in front of the user — which is precisely the "half the loading happens after the loading screen ' +
        'goes away" symptom. The `error` field above is what threw. This is a bug with a receipt, not a ' +
        'cosmetic warning.',
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
      '⚠️ WINDOW CAVEAT (mythica-machina-press#583): these probes are armed AFTER `startRealSceneViewer()` ' +
      'resolves, and BOTH deliberate compile events — `renderer.compileAsync(scene, camera)` and the ' +
      '`warmUpDrawState()` pass-plan draw — run INSIDE that call. So this total covers compiles that happened ' +
      'after the warm-up, and a small number here does NOT mean little compilation occurred this load; it means ' +
      'little occurred in the part of it that was watched. Use `warmUp.pipelinesCreated` / ' +
      '`warmUp.simPipelinesCreated` for what the warm-up itself compiled. ' +
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
    report.warmUp = buildWarmUpSection(diagnostics?.warmUp ?? null);
    report.compression = buildCompressionSection(diagnostics?.compression ?? null);
    report.background = buildBackgroundSection(state.currentHiddenMs ?? null, totalMs);
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
    report.warmUp = buildWarmUpSection(diagnostics?.warmUp ?? null);
    report.compression = buildCompressionSection(diagnostics?.compression ?? null);
    report.background = buildBackgroundSection(last.hiddenMs ?? null, totalMs);
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
