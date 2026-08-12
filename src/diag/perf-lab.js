/**
 * perf-lab.js — the Effect Performance Lab.
 *
 * The author's directive (2026-07-20): NO console commands — one debug-panel button
 * that opens a tool which auto-sweeps every effect and reports, per effect, its real
 * GPU cost. "Run sweep" turns each registered effect off→on in turn and, per config,
 * measures TWO separate things in TWO separate sub-phases (do not merge them — see
 * the post-mortem below):
 *   1. FELT — natural, unthrottled rendering for a stretch, reading the real frame-gap
 *      distribution (vt-pan-viewer's frameGapTimes/hitchLog).
 *   2. GPU — the render loop THROTTLED to one frame in flight at a time (diag/gpu-probe.js
 *      via harness.setGpuProbe; the viewer skips submitting new work while a sample is
 *      awaiting GPU completion), polled until enough samples land.
 * Per-effect GPU cost = its solo GPU reading minus the all-off baseline's. Scene section:
 * baseline vs all-on GPU, felt P50/P95, and an implied "Foundry / everything else" line
 * (MSA's WebGPU device is separate from Foundry's PIXI, so `felt − MSA_gpu` is everything
 * that isn't us).
 *
 * ⚠️ POST-MORTEM (2026-07-20, live, author-caught): the FIRST version measured GPU cost
 * WITHOUT throttling — the render loop kept submitting new frames every ~8ms regardless of
 * probe state, so `onSubmittedWorkDone()` for one frame resolved only after several OTHER
 * frames' pipelined work had ALSO gone through the queue. That measures pipeline QUEUE
 * DEPTH, not per-frame cost. The tell was in the very first live report: "All effects GPU
 * 41.90ms" beside "Frame (felt) P50 8.40ms" — physically impossible for one frame's real
 * execution time (you cannot sustain 8.4ms/frame output while each frame individually costs
 * 41.9ms, unless several frames are pipelined in flight at once, which is exactly what an
 * unthrottled loop does) — plus a negative "UI window shadows: -0.30ms" and a negative
 * "Foundry / other: -33.50ms", both physically impossible for real costs. The fix is the
 * render-loop throttle in vt-pan-viewer.js (gated on gpuProbe.isMeasuring()) plus splitting
 * felt/GPU into separate sub-phases so the throttling's own stalls never pollute felt.
 *
 * INJECTION (boot owns the wiring; this file knows nothing of effects/ or settings):
 *   harness.listEffects(): {id, label}[]
 *   harness.setForcedEnabled(id, boolean|null): transient on/off; null restores the real
 *     cascade. NEVER persists a setting.
 *   harness.setGpuProbe(on): arm/disarm the gated + THROTTLING GPU probe (arming clears
 *     prior samples; while armed the viewer submits one frame at a time).
 *   harness.resetFrameStats(): clear the shared felt rolling windows (frameGapTimes/
 *     hitchLog) — call before each config's felt phase, else one config's reading is
 *     smeared with whatever ran before it (a prior config, or the GPU phase's own throttled
 *     stalls, which would otherwise show up as fake multi-second "hitches").
 *   harness.readCost(): { gpuProbe:{gpuMsMedian, gpuMsP95, gpuMsMax, sampleCount},
 *     hitchStats:{frameGapP50Ms, frameGapP95Ms, hitchCount}, renderMsAvgLast120 }
 *
 * ⚠️ SECOND POST-MORTEM (2026-07-29, author-caught, from two pasted live reports): the
 * throttle fix above was real and held — but the report it produced was still mostly
 * unresolvable noise PRESENTED AS A RANKING. Three defects, all now fixed here:
 *   1. THE BASELINE WAS MEASURED ONCE, FIRST — the single worst slot for the one number
 *      every per-effect cost is subtracted from. See `buildSweepConfigs`. It is now
 *      measured again at the END; the pair AVERAGES (killing the one-sided cold-start
 *      bias) and its DIFFERENCE is `noiseFloorMs`, a real in-run resolution floor.
 *   2. NOTHING KNEW WHAT THE TOOL COULD RESOLVE. Nine of eleven effects came back inside
 *      the floor, seven of them NEGATIVE, each printed to 0.1 ms with a share of the
 *      stack ("−64.3% of effects"). Costs now carry `resolved`, and a share that would be
 *      a percentage of noise is suppressed (feedback_instruments_must_not_lie).
 *   3. `impliedOtherMs` SUBTRACTED TWO INCOMMENSURABLE CLOCKS. `feltP50` is read
 *      unthrottled, `gpuMs` throttled; once MSA's GPU frame exceeds the felt gap, that gap
 *      is the display's cadence with the queue absorbing the overrun, not presentation.
 *      The difference is then negative BY CONSTRUCTION — the reports showed −10.0 ms and
 *      −5.2 ms, the same signature as the −33.50 ms above, and nothing flagged it because
 *      `formatOther` only excused −2…0. It is now `null` + `feltUnderstated`, and the
 *      panel states the pipelining conclusion outright, which is the useful reading.
 *
 * ⚠️ THIRD POST-MORTEM (2026-08-06, from a live report pasted back for review): the
 * SECOND post-mortem's `resolved` check was `Math.abs(cost) > noiseFloor` — magnitude
 * only, no sign. A live run showed `doorGraphics: -1.3ms` and `grade: -1.5ms` BOTH marked
 * `resolved: true`, each with a nonsensical negative "% of effects" (-48.1%, -55.6%) —
 * the exact "physically impossible negative cost" class the second post-mortem's own
 * evidence already named, just past the floor instead of inside it. An effect cannot cost
 * less than zero; a negative reading that clears the floor is not a precisely-measured
 * saving, it is a systematic bias (this run: a near-monotonic GPU-clock warm-up climb from
 * ~19.3ms on the first few configs to ~23.4ms on the last few — the two-point baseline
 * average only cancels a LINEAR drift, and does nothing for a warm-up curve that is mostly
 * over by the time the closing baseline lands) big enough to swamp the floor. Two fixes:
 *   1. `resolved` now requires `cost > noiseFloor` (positive AND clear of the floor), not
 *      `Math.abs(cost) > noiseFloor` — see `summarizeSweep`.
 *   2. A NEW `suspiciousNegative` flag on confidently-negative rows, surfaced by
 *      `formatCost` as "⚠ drift, not cost" rather than silently folding into "< noise" —
 *      the two are different findings ("we can't tell" vs. "something during this run
 *      made this look cheaper than baseline, and it wasn't the effect").
 *   3. `runSweep` gained an optional GPU warm-up phase (`warmupFrames`, all effects forced
 *      on, off the measured clock) specifically to shrink this class of drift at the
 *      source rather than only detect it after the fact.
 *   4. The report now carries `context` (scene/floor/resolution/tier/msaVersion, from
 *      `harness.getContext()`) so two runs are actually comparable, and a `notes` array
 *      explaining what the percentages do and don't mean.
 *
 * The pure helpers (config list, per-effect delta math, formatting) are Node-tested;
 * runSweep/waitForGpuSamples are testable with an injected harness + frame-waiter; the DOM
 * panel is browser-verified (CONVENTIONS §4).
 */
import { createLogger } from '../core/log.js';
// Single source of truth for how long a structural toggle needs to settle
// after being flipped before it is safe to measure — see that module's own
// header. Importing rather than re-declaring a second constant here is
// deliberate: two settle-frame numbers for the SAME toggle, hand-maintained
// in two files, is exactly how they drift apart from each other unnoticed.
import { toggleById } from './perf-structural-ab.js';

const log = createLogger('perf-lab');

const BASELINE_KEY = '__baseline__';
const ALL_KEY = '__all__';
/**
 * THE CLOSING BASELINE — the same all-off config, re-measured at the END of the sweep.
 * See `buildSweepConfigs`/`summarizeSweep`: it exists to fix a systematic bias AND to
 * hand back a MEASURED noise floor, from one extra config.
 */
const BASELINE2_KEY = '__baseline2__';

// ---- pure helpers --------------------------------------------------------

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function round2(v) {
  return v == null ? null : Math.round(v * 100) / 100;
}
function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}

/**
 * Estimate the sweep's own noise floor, from the sweep's own results.
 *
 * MOVED HERE from perf-report.js 2026-08-06 (re-exported there for backward
 * compatibility) — this is entirely about interpreting THIS instrument's own
 * noise, and `summarizeSweep` below now calls it internally so the standalone
 * sweep display and perf-report.js's combined `effects[]` can never disagree
 * about which readings are trustworthy (they used to: this function's
 * reconciled floor and `summarizeSweep`'s own bracketing-pair-only floor were
 * two different numbers computed two different ways, and a live report showed
 * 5 effects marked `resolved:true` in one place and rejected as noise in the
 * other, for the exact same figure).
 *
 * ============================================================================
 * WHY THIS EXISTS — the sweep is a DIFFERENCE OF TWO LARGE NUMBERS
 * ============================================================================
 *
 * A sweep cost is `soloFrameGpu - baselineFrameGpu`, each a median of ~20
 * whole-frame samples. At a 21.6 ms frame, resolving a 0.1 ms effect means
 * resolving 0.5% of each measurement — far below the run-to-run variance of a
 * real GPU. The tell is unmistakable and it showed up on the first working
 * sweep (2026-07-27): **negative costs.** Vegetation -0.9 ms, doorGraphics
 * -1.1 ms, water -0.8 ms, and `uiWindowShadow` — which was DISABLED and has no
 * draw call at all by design — charged +0.6 ms.
 *
 * A negative GPU cost is physically impossible, so every negative reading is
 * pure noise, and its magnitude is a DIRECT, SELF-CALIBRATING lower bound on how
 * much noise this particular sweep carried. Anything inside ±that band is
 * unresolvable and must not be reported as a number.
 *
 * This is deliberately empirical rather than a tuned constant: the floor scales
 * with the machine, the scene and the frame cost, exactly as it should
 * (`feedback_probed_constants_vs_derived` — derive it once from the data, do not
 * hardcode a guess).
 *
 * ⚠️ THIS IS A LOWER BOUND, AND IT HAS A HOLE: it can only see noise that happened
 * to land on the negative side of an effect that happened to be cheap. A sweep where
 * every effect read slightly POSITIVE returns `null` — "no evidence" — even though the
 * noise obviously did not go away. `summarizeSweep` also measures the floor DIRECTLY
 * (it re-runs the identical all-off baseline at the end of the sweep; two runs of the
 * same config can differ only by noise), which has no such hole. Both are lower bounds
 * on the same quantity, so the honest combination is the LARGER: a −1.8 ms reading is
 * still proof the floor is at least 1.8 ms even if the bracketing pair drifted less.
 * Passing the measured value is strongly preferred; the derivation stays as the
 * fallback for reports produced before it existed.
 *
 * @param {Array<{costMs?: number|null}>} perEffect
 * @param {number|null} [measuredFloorMs] the bracketing-pair drift magnitude, when
 *   the sweep produced one (this file's own `baselineDriftFloor`).
 * @returns {number|null} the floor in ms, or null when neither source has evidence
 *   (in which case we know nothing about the noise either way).
 */
export function estimateSweepNoiseFloor(perEffect, measuredFloorMs = null) {
  const measured = Number.isFinite(measuredFloorMs) && measuredFloorMs > 0 ? measuredFloorMs : null;
  if (!Array.isArray(perEffect) || perEffect.length === 0) return measured;
  let worstNegative = 0;
  for (const e of perEffect) {
    const c = e?.costMs;
    if (Number.isFinite(c) && c < worstNegative) worstNegative = c;
  }
  const derived = worstNegative < 0 ? Math.abs(worstNegative) : null;
  if (derived == null) return measured;
  if (measured == null) return derived;
  return Math.max(derived, measured);
}

/**
 * The ordered configs a sweep runs: an all-OFF baseline (the scene's own cost), then
 * each effect ON alone (its marginal cost = solo − baseline), then all ON together (so
 * `all − baseline` is the whole effect stack and `felt − all` is Foundry/vsync/etc),
 * and finally THE SAME all-off baseline again.
 * The all-on row is omitted when there is only one effect (it would duplicate its solo).
 *
 * ⚠️ WHY THE BASELINE IS MEASURED TWICE (2026-07-29 — the fix for two live sweeps whose
 * numbers were mostly noise being presented as precision):
 *
 * EVERY per-effect cost is `solo − baseline`, so the baseline is a shared divisor on
 * eleven answers. Measuring it ONCE, FIRST, is the worst possible place for it: it is
 * the only config that pays cold-pipeline costs (the forced-toggle shader rebuilds, the
 * first residency pass, a cold thermal/clock state), and any drift it carries is
 * subtracted from every effect in the run. A live sweep showed exactly that shape —
 * baseline 10.8 ms against NINE of eleven solo configs reading LOWER than it, seven of
 * them clustered at −1.3…−1.8 ms. Random noise scatters both ways; that is a systematic
 * offset, and it made seven effects report a physically impossible negative cost.
 *
 * Re-measuring the identical config at the END fixes both halves at once:
 *   - the two readings AVERAGE, so a one-sided cold-start/thermal bias cancels instead
 *     of landing on all eleven effects;
 *   - their DIFFERENCE is a genuine, in-run, same-machine, same-scene measurement of
 *     this sweep's own repeatability — `noiseFloorMs`. Two runs of a config that is
 *     BY CONSTRUCTION identical can only differ by noise, so anything smaller than that
 *     gap is unresolvable BY THIS RUN'S OWN EVIDENCE, not by a guessed threshold
 *     (feedback_probed_constants_vs_derived — derive the cutoff, never eyeball it).
 *
 * @param {{id:string,label?:string}[]} effects
 * @returns {{key:string,label:string,on:string[]}[]}
 */
export function buildSweepConfigs(effects) {
  const list = Array.isArray(effects) ? effects.filter((e) => e && typeof e.id === 'string') : [];
  const ids = list.map((e) => e.id);
  const configs = [{ key: BASELINE_KEY, label: 'Scene only (all effects off)', on: [] }];
  for (const e of list) configs.push({ key: e.id, label: e.label || e.id, on: [e.id] });
  if (ids.length > 1) configs.push({ key: ALL_KEY, label: 'All effects on', on: ids.slice() });
  // The closing baseline is worth its ~2s only when it is actually bracketing something.
  if (ids.length > 0)
    configs.push({ key: BASELINE2_KEY, label: 'Scene only (repeat — measures this run’s noise)', on: [] });
  return configs;
}

/**
 * Reduce a sweep's raw per-config readings into a report. Per effect: marginal GPU cost
 * (solo − baseline) and its share of the whole effect stack. Scene: baseline vs all-on
 * GPU + felt, and impliedOtherMs = all-on felt − all-on MSA-GPU (Foundry + vsync + rest).
 * All fields are `null` (never a lying 0) where a reading is missing. `gpuSampleCount` is
 * carried through per config so a thin/zero sample never LOOKS as trustworthy as a solid one.
 * @param {Record<string,{gpuMs?:number,gpuP95?:number,gpuSampleCount?:number,feltP50?:number,feltP95?:number,hitchCount?:number}>} raw
 * @param {{id:string,label?:string}[]} effects
 */
export function summarizeSweep(raw, effects) {
  const safeRaw = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(effects) ? effects.filter((e) => e && typeof e.id === 'string') : [];
  const base = safeRaw[BASELINE_KEY] ?? {};
  const base2 = safeRaw[BASELINE2_KEY] ?? {};
  const allCfg = safeRaw[ALL_KEY] ?? (list.length === 1 ? (safeRaw[list[0].id] ?? {}) : {});
  const baseGpuOpen = num(base.gpuMs);
  const baseGpuClose = num(base2.gpuMs);
  // AVERAGE the bracketing baselines (see buildSweepConfigs) so a one-sided cold-start or
  // thermal drift cancels instead of biasing all N effect costs. One reading → use it.
  const baseGpu =
    baseGpuOpen != null && baseGpuClose != null ? (baseGpuOpen + baseGpuClose) / 2 : (baseGpuOpen ?? baseGpuClose);
  // THE MEASURED RESOLUTION FLOOR, HALF ONE — the bracketing pair. Two runs of a
  // BY-CONSTRUCTION identical config can only differ by noise.
  const baselineDrift = baseGpuOpen != null && baseGpuClose != null ? baseGpuClose - baseGpuOpen : null;
  const baselineDriftFloor = baselineDrift == null ? null : Math.abs(baselineDrift);
  const allGpu = num(allCfg.gpuMs);
  const totalEffectGpu = baseGpu != null && allGpu != null ? allGpu - baseGpu : null;

  // PASS 1 — raw costs only, before any resolved/suspicious labelling. Needed
  // up front because the FLOOR itself (below) depends on seeing every effect's
  // cost first — the worst negative among THEM, not just the bracketing pair.
  const rawCosts = list.map((e) => {
    const r = safeRaw[e.id] ?? {};
    const solo = num(r.gpuMs);
    const cost = baseGpu != null && solo != null ? solo - baseGpu : null;
    return { e, r, solo, cost };
  });

  // THE MEASURED RESOLUTION FLOOR, HALF TWO, RECONCILED — the larger of the
  // bracketing-pair drift and the worst negative reading among THIS RUN's own
  // effects (estimateSweepNoiseFloor's own doc: both are lower bounds on the
  // same quantity, and the honest combination is the larger). Fixed 2026-08-06
  // — a live report showed 5 effects marked `resolved:true` HERE (this
  // function used the bracketing-pair floor alone, 0.1ms that run) while the
  // SAME numbers were rejected as `sweepUnresolvable:'below-noise-floor'` in
  // perf-report.js's combined effects[] (which already combined both floors,
  // landing on 1.35ms) — one report, two disagreeing verdicts on one number.
  const noiseFloor = estimateSweepNoiseFloor(
    rawCosts.map(({ cost }) => ({ costMs: cost })),
    baselineDriftFloor
  );

  const perEffect = rawCosts
    .map(({ e, r, solo, cost }) => {
      // `null` = no floor was measured (an old report, or a one-baseline sweep) — that is
      // "unknown", NOT "resolved", and must not read as a clean bill of health.
      //
      // POSITIVE and clear of the floor — not `Math.abs(cost) > noiseFloor` (THIRD
      // post-mortem, this file's header). An effect cannot cost less than zero; a
      // negative reading big enough to clear the floor is a systematic bias (warm-up
      // drift, most likely), not a measured saving, and must not read as "resolved".
      const resolved = cost == null || noiseFloor == null ? null : cost > noiseFloor;
      // A negative cost past the BRACKETING-PAIR floor is a DIFFERENT finding from
      // "inside the noise" — it says something during the run made this look cheaper
      // than baseline, and formatCost gives it its own label rather than folding it
      // into "< noise". Compared against `baselineDriftFloor`, NOT the reconciled
      // `noiseFloor` above — the reconciled floor is defined as (among other things)
      // the worst negative reading ACROSS ALL effects, so no single effect's own
      // magnitude can ever exceed it (it can at best tie, if it IS that worst
      // reading); comparing a cost against a floor partly built FROM that same cost
      // would make this permanently unreachable. `baselineDriftFloor` — the
      // bracketing pair alone, independent of any individual effect's reading — is
      // the honest, non-circular comparison: "bigger than what re-measuring the
      // SAME idle scene twice already told us to expect from noise alone".
      const suspiciousNegative = cost != null && cost < 0 && Math.abs(cost) > (baselineDriftFloor ?? 0);
      // A PERCENTAGE OF NOISE IS NOT A PERCENTAGE. The live reports that prompted this
      // printed "−64.3% of effects" for a −1.8 ms reading on an effect that cannot have a
      // negative cost. Suppress the share when the underlying ms is unresolvable; keep the
      // raw ms visible either way, so nothing is hidden — only the false precision goes
      // (feedback_instruments_must_not_lie).
      const pct = cost != null && totalEffectGpu && resolved !== false ? round1((cost / totalEffectGpu) * 100) : null;
      return {
        id: e.id,
        label: e.label || e.id,
        gpuMsSolo: round2(solo),
        costMs: round2(cost),
        resolved,
        suspiciousNegative,
        gpuP95: round2(num(r.gpuP95)),
        gpuSampleCount: r.gpuSampleCount ?? 0,
        pctOfEffects: pct,
      };
    })
    // Most expensive first — the whole point is "what's the fat one".
    .sort((a, b) => (b.costMs ?? -Infinity) - (a.costMs ?? -Infinity));

  const allFelt = num(allCfg.feltP50);
  // ⚠️ THE FELT AND GPU NUMBERS COME FROM TWO DIFFERENT EXECUTION REGIMES and may only be
  // subtracted while one bounds the other. `feltP50` is read UNTHROTTLED (frames pipeline
  // freely); `gpuMs` is read THROTTLED to one frame in flight. When MSA's own per-frame GPU
  // work EXCEEDS the observed frame gap, that gap cannot be presentation — the queue is
  // absorbing the overrun and the rAF cadence keeps ticking at the display's rate — so
  // `felt − gpu` is not "Foundry + everything else", it is an artefact, and it always comes
  // out negative. This file's own header records a "-33.50ms Foundry/other" as the tell of
  // the original queue-depth bug; two live sweeps then quietly reported −10.0 and −5.2 with
  // nothing flagging them, because `formatOther` only excuses −2…0. Report `null` and say
  // why, rather than a number that cannot mean what its label claims.
  const feltUnderstated = allGpu != null && allFelt != null && allGpu > allFelt;
  const impliedOtherMs = allGpu != null && allFelt != null && !feltUnderstated ? round2(allFelt - allGpu) : null;

  // ---- notes: permanent caveats + this-run-specific warnings, always plain language ----
  const notes = [];
  const anySuspiciousNegative = perEffect.some((e) => e.suspiciousNegative);
  const anyResolved = perEffect.some((e) => e.resolved === true);
  if (anyResolved) {
    notes.push(
      "Each effect's % is its OWN share of totalEffectGpuMs (all-on minus baseline), measured " +
        'independently — solo readings do not have to sum to the whole stack (driver caching, shared ' +
        'GPU state and per-effect noise all break the arithmetic a little), so shares can legitimately ' +
        'add up to more or less than 100%. Treat them as a rough ranking, not an exact partition.'
    );
  }
  if (anySuspiciousNegative) {
    notes.push(
      "⚠ One or more effects read CHEAPER than the baseline by more than this run's own noise floor " +
        '(marked "drift, not cost" below). That is not a real saving — an effect cannot cost less than ' +
        'zero — it means something changed systematically DURING the run (most often the GPU still ' +
        'boost-clocking up under load). Re-run with a longer warmupFrames, or cross-check the suspect ' +
        "effect against the per-zone Profile report, which doesn't depend on a drifting baseline at all."
    );
  }
  // The whole-stack delta is itself just another two-point measurement, subject to the
  // exact same drift/noise as any single effect — if IT can't clear the floor, every
  // percentage computed against it is a share of a number this run cannot resolve either.
  if (totalEffectGpu != null && noiseFloor != null && Math.abs(totalEffectGpu) <= noiseFloor) {
    notes.push(
      `⚠ totalEffectGpuMs (${round2(totalEffectGpu)}ms) is itself at or below this run's noise floor ` +
        `(${round2(noiseFloor)}ms) — every per-effect percentage below is a share of a number this run ` +
        'genuinely could not resolve. The ms figures are still the best available reading; the rankings ' +
        'and percentages are not.'
    );
  }
  if (baselineDrift != null && baseGpu > 0 && Math.abs(baselineDrift) / baseGpu > 0.03) {
    notes.push(
      `Notable drift this run: the closing baseline differs from the opening one by ` +
        `${round2(baselineDrift)}ms (${round1((Math.abs(baselineDrift) / baseGpu) * 100)}% of the baseline ` +
        'itself) — consistent with the GPU still reaching steady clock speed partway through the sweep. ' +
        'A longer warmupFrames (or simply re-running once the scene has already been panning for a bit) ' +
        'should shrink this.'
    );
  }

  return {
    perEffect,
    notes,
    baseline: {
      gpuMs: round2(baseGpu),
      gpuSampleCount: base.gpuSampleCount ?? 0,
      feltP50: round2(num(base.feltP50)),
      feltP95: round2(num(base.feltP95)),
      hitchCount: base.hitchCount ?? null,
    },
    all: {
      gpuMs: round2(allGpu),
      gpuSampleCount: allCfg.gpuSampleCount ?? 0,
      feltP50: round2(allFelt),
      feltP95: round2(num(allCfg.feltP95)),
      hitchCount: allCfg.hitchCount ?? null,
    },
    totalEffectGpuMs: round2(totalEffectGpu),
    // The bracketing pair, kept visible: a large drift is itself a finding (the machine
    // warmed up, or something leaked across the sweep), not just an error bar.
    baselineOpenMs: round2(baseGpuOpen),
    baselineCloseMs: round2(baseGpuClose),
    baselineDriftMs: round2(baselineDrift),
    noiseFloorMs: round2(noiseFloor),
    impliedOtherMs,
    feltUnderstated,
  };
}

/** Display a millisecond value, or an em dash for "not measured" (never a fake 0). */
export function formatMs(v) {
  return num(v) == null ? '—' : `${num(v).toFixed(2)} ms`;
}

/**
 * Display the implied "Foundry / other" line. A SMALL negative value is expected
 * measurement noise (felt frame-gap and throttled-GPU-median are not perfectly
 * commensurate clocks) and must not read as a scary, impossible negative cost — it is
 * clamped to a labelled "≈0".
 *
 * ⚠️ The LARGE-negative case no longer reaches here from a real sweep: `summarizeSweep`
 * now returns `null` when MSA's GPU work exceeds the felt gap, because in that regime the
 * subtraction has no meaning at all (see its `feltUnderstated` note) — a number that big
 * and that negative was never "surprising but real", it was two clocks being differenced.
 * The branch stays as input validation for a hand-fed value.
 */
export function formatOther(v) {
  const n = num(v);
  if (n == null) return '—';
  if (n < 0 && n > -2) return '≈0 ms (within noise)';
  return formatMs(n);
}

/**
 * Display a per-effect GPU cost against the run's own measured floor. An unresolvable
 * reading keeps its raw number (nothing is hidden) but is stated as being below the floor,
 * so it can never be read as a ranked result. `resolved === null` means no floor was
 * measured — "unknown", which is NOT the same as "fine". `suspiciousNegative` (THIRD
 * post-mortem, this file's header) gets its OWN label: a negative reading big enough to
 * clear the floor is not "we can't tell" (that's `resolved === false` alone), it is "this
 * run's own evidence says something biased the measurement, and it wasn't the effect".
 * @param {{costMs:number|null, resolved:boolean|null, suspiciousNegative?:boolean}} e
 */
export function formatCost(e) {
  const s = formatMs(e?.costMs);
  if (e?.suspiciousNegative) return `⚠ drift, not cost (${s})`;
  if (e?.resolved === false) return `< noise (${s})`;
  if (e?.resolved == null) return `${s} (unverified floor)`;
  return s;
}

// ---- orchestration -------------------------------------------------------

/** Wait n animation frames (real rAF). Injected as `waitFrames` in tests. */
function defaultWaitFrames(n) {
  return new Promise((resolve) => {
    let left = Math.max(0, Number(n) | 0);
    const step = () => {
      if (left-- <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/**
 * Poll (via `waitFrames`) until the GPU probe has collected `target` samples or `maxPolls`
 * is exhausted. Never hangs a sweep on a probe that yields nothing (e.g. a non-WebGPU
 * backend): it just gives up and returns whatever count it has, which the report then
 * shows honestly (a thin/zero sample never masquerades as a solid reading — see
 * formatMs/gpuSampleCount). Exported and independently testable.
 * @param {object} harness see the file header
 * @param {number} target
 * @param {{waitFrames:Function, pollFrames?:number, maxPolls?:number}} opts
 * @returns {Promise<number>} the sample count actually reached
 */
export async function waitForGpuSamples(harness, target, opts = {}) {
  const { waitFrames, pollFrames = 4, maxPolls = 120 } = opts;
  for (let i = 0; i < maxPolls; i++) {
    const count = harness.readCost()?.gpuProbe?.sampleCount ?? 0;
    if (count >= target) return count;
    await waitFrames(pollFrames);
  }
  return harness.readCost()?.gpuProbe?.sampleCount ?? 0;
}

/**
 * Run the full sweep. Per config, TWO SEPARATE sub-phases (see the file header's
 * post-mortem for why they must not be merged):
 *   1. Settle the effect toggle, then FELT: reset the shared frame-gap window
 *      (harness.resetFrameStats) and let the loop run at its natural, unthrottled
 *      cadence for `feltFrames` ticks — this is the real, felt frame pacing.
 *   2. GPU: arm the probe (which also THROTTLES the render loop to one frame in
 *      flight — vt-pan-viewer.js), poll (waitForGpuSamples) until `gpuSampleTarget`
 *      samples land, then disarm.
 * ALWAYS restores every effect to its real cascade in `finally`, even on error (and
 * disarms the probe + clears frame stats), so a sweep can never leave the scene forced
 * or its own throttling misreported as real hitches in the next diagnostics read.
 *
 * OPTIONAL GPU WARM-UP FIRST (THIRD post-mortem, this file's header): forces every
 * effect ON — the heaviest config, the same shape `__all__` measures — and waits
 * `warmupFrames` before the timed portion even begins. Off the measured clock entirely
 * (no `raw` entry, no onProgress `felt`/`gpu` phase), it exists purely to let a GPU still
 * ramping up its clocks under load finish ramping BEFORE any config is timed, rather than
 * during the run where the two-baseline average can only partially correct for it.
 * @param {object} harness see the file header
 * @param {{settleFrames?:number, feltFrames?:number, gpuSampleTarget?:number,
 *   pollFrames?:number, maxGpuPolls?:number, warmupFrames?:number, onProgress?:Function,
 *   waitFrames?:Function}} [opts]
 */
export async function runSweep(harness, opts = {}) {
  const {
    // RAISED 2026-08-06 (author: "I do not mind if you make the report generation
    // take much longer, accuracy is more important"). This tool now only ever
    // runs as ONE HALF of the combined Performance Report button, never a quick
    // check nobody minds re-running — so every knob below is set for the
    // tightest floor this instrument can deliver, not the fastest one.
    settleFrames = 45,
    feltFrames = 120,
    // 20 was not enough to resolve most effects: two live sweeps put nine of eleven
    // readings inside their own noise, several of them negative. The median's error falls
    // as ~1/√n, so doubling the target buys ~1.4× tighter costs for ~1s more per config.
    // `summary.noiseFloorMs` is now the signal for whether even this is enough — if the
    // floor comes back larger than the effect being chased, raise this, don't squint.
    gpuSampleTarget = 90,
    pollFrames = 4,
    maxGpuPolls = 240,
    // ~180 frames is a few seconds at any plausible frame rate — long enough for a GPU's
    // boost-clock ramp to settle (the mechanism behind the drift a live report showed:
    // gpuMs climbing ~19.3ms→23.4ms over the course of a run). Raised further alongside
    // the rest of this run's knobs — a colder start (first sweep of a session) deserves
    // more margin than a mid-session re-run, and this tool has no way to tell them apart.
    warmupFrames = 300,
    onProgress = () => {},
    waitFrames = defaultWaitFrames,
  } = opts;
  const effects = harness.listEffects() ?? [];
  const configs = buildSweepConfigs(effects);
  const raw = {};
  try {
    if (warmupFrames > 0 && effects.length > 0) {
      onProgress({ index: -1, total: configs.length, label: 'GPU warm-up', phase: 'warmup' });
      for (const e of effects) harness.setForcedEnabled(e.id, true);
      await waitFrames(warmupFrames);
    }
    for (let ci = 0; ci < configs.length; ci++) {
      const cfg = configs[ci];
      harness.setGpuProbe(false);
      for (const e of effects) harness.setForcedEnabled(e.id, cfg.on.includes(e.id));
      await waitFrames(settleFrames);

      // FELT — natural cadence. Reset FIRST so this config's reading is not smeared
      // with whatever ran before it (the shared window is not per-config on its own).
      onProgress({ index: ci, total: configs.length, label: cfg.label, phase: 'felt' });
      harness.resetFrameStats();
      await waitFrames(feltFrames);
      const felt = harness.readCost() ?? {};

      // GPU — throttled single-frame-in-flight (see vt-pan-viewer's renderFrame
      // guard). Arming clears prior samples on its own OFF→ON edge.
      onProgress({ index: ci, total: configs.length, label: cfg.label, phase: 'gpu' });
      harness.setGpuProbe(true);
      await waitForGpuSamples(harness, gpuSampleTarget, { waitFrames, pollFrames, maxPolls: maxGpuPolls });
      harness.setGpuProbe(false);
      const gpu = harness.readCost() ?? {};

      raw[cfg.key] = {
        gpuMs: gpu.gpuProbe?.gpuMsMedian ?? null,
        gpuP95: gpu.gpuProbe?.gpuMsP95 ?? null,
        gpuSampleCount: gpu.gpuProbe?.sampleCount ?? 0,
        feltP50: felt.hitchStats?.frameGapP50Ms ?? null,
        feltP95: felt.hitchStats?.frameGapP95Ms ?? null,
        hitchCount: felt.hitchStats?.hitchCount ?? null,
      };
    }
  } finally {
    harness.setGpuProbe(false);
    for (const e of effects) harness.setForcedEnabled(e.id, null); // restore the real cascade
    harness.resetFrameStats?.(); // leave the session's own diagnostics clean afterward
  }
  // Scene/floor/resolution/build — so a report pasted back later, or compared against a
  // previous one, says what it actually ran against instead of leaving that to memory.
  // Optional: an older or minimal harness without `getContext` still returns a full report.
  const context = harness.getContext?.() ?? null;
  return { effects, configs, context, raw, summary: summarizeSweep(raw, effects) };
}

/**
 * A delta between two INDEPENDENT full sweeps must clear this multiple of
 * their own noise floor to earn a verdict — same reasoning, same factor, as
 * `perf-structural-ab.js`'s `AB_SIGNIFICANCE_FACTOR` (not imported: that
 * constant belongs to a different comparison shape — one run's own
 * bracketing-pair drift, not two independent runs' floors maxed together —
 * and importing a same-VALUED-by-coincidence constant across an unrelated
 * boundary is worse than a second `1.5` with its own citation).
 */
export const SWEEP_AB_SIGNIFICANCE_FACTOR = 1.5;

/**
 * Compare two full `runSweep` results taken under different structural-toggle
 * states. Two readings matter, for different reasons:
 *
 *   - `baselineDeltaMs` — the ALL-EFFECTS-OFF scene cost, on vs off. This is
 *     the CLEANEST possible reading of what the toggle itself costs: no
 *     effect's shader, no bloom/DoF chain, nothing but the raw geometry/depth
 *     pipeline the toggle actually changes. If early-Z (or any future
 *     structural toggle) has a real cost, THIS is where it shows most clearly.
 *   - `allOnDeltaMs` — the ALL-EFFECTS-ON scene cost, on vs off. The
 *     real-world reading, with the full effect stack active. If this
 *     DISAGREES with `baselineDeltaMs` beyond noise, that is itself a finding
 *     — some effect's cost is coupled to the toggle in a way nobody expected
 *     — and is left visible rather than averaged away.
 *
 * ⚠️ THE NOISE FLOOR HERE IS A CONSERVATIVE APPROXIMATION, NOT A MEASURED ONE.
 * Each sweep's own `noiseFloorMs` comes from re-measuring the SAME config
 * (its bracketing baseline pair) within ONE continuous run — a real,
 * in-run measurement. Comparing ACROSS two independent sweeps, taken
 * minutes apart with a toggle flip and a settle wait in between, has no
 * equivalent same-run bracketing pair to measure ITS noise directly. Taking
 * the larger of the two runs' own floors is a reasonable lower bound, not a
 * proof — cross-run drift (further thermal drift, a differently-timed
 * warm-up) could exceed it. Treat a `pays-for-itself`/`costs-more-than-it-
 * saves` verdict here as a strong signal, not the same evidentiary weight as
 * `perf-structural-ab.js`'s own same-run ON→OFF→ON design.
 */
export function compareSweepPair(on, off) {
  const s1 = on?.summary;
  const s2 = off?.summary;
  if (!s1 || !s2) {
    return {
      verdict: 'unmeasured',
      note: 'At least one of the two sweeps produced no summary at all, so no comparison is possible.',
      baselineDeltaMs: null,
      allOnDeltaMs: null,
      noiseFloorMs: null,
      perEffect: [],
    };
  }
  const floor = Math.max(s1.noiseFloorMs ?? 0, s2.noiseFloorMs ?? 0) || null;
  const baselineDeltaMs =
    num(s1.baseline?.gpuMs) != null && num(s2.baseline?.gpuMs) != null
      ? round2(s1.baseline.gpuMs - s2.baseline.gpuMs)
      : null;
  const allOnDeltaMs =
    num(s1.all?.gpuMs) != null && num(s2.all?.gpuMs) != null ? round2(s1.all.gpuMs - s2.all.gpuMs) : null;

  const significant =
    baselineDeltaMs != null && floor != null && Math.abs(baselineDeltaMs) > floor * SWEEP_AB_SIGNIFICANCE_FACTOR;
  const verdict =
    baselineDeltaMs == null || floor == null
      ? 'unmeasured'
      : !significant
        ? 'within-noise'
        : baselineDeltaMs < 0
          ? 'pays-for-itself'
          : 'costs-more-than-it-saves';

  // Every effect present in BOTH runs — normally all of them, since the same
  // harness.listEffects() feeds both sweeps, but a live toggle of the effect
  // registry mid-run (unlikely, not impossible) must not crash this.
  const perEffect = [];
  const offById = new Map((s2.perEffect ?? []).map((e) => [e.id, e]));
  for (const e1 of s1.perEffect ?? []) {
    const e2 = offById.get(e1.id);
    if (!e2) continue;
    perEffect.push({
      id: e1.id,
      label: e1.label,
      onCostMs: e1.costMs,
      offCostMs: e2.costMs,
      deltaMs: e1.costMs != null && e2.costMs != null ? round2(e1.costMs - e2.costMs) : null,
      onResolved: e1.resolved,
      offResolved: e2.resolved,
    });
  }
  // Biggest absolute mover first, unresolved-on-both-sides last — matches the
  // "what should I look at first" ordering this file uses everywhere else.
  perEffect.sort((a, b) => Math.abs(b.deltaMs ?? -Infinity) - Math.abs(a.deltaMs ?? -Infinity));

  const agree =
    baselineDeltaMs != null &&
    allOnDeltaMs != null &&
    floor != null &&
    Math.abs(baselineDeltaMs - allOnDeltaMs) <= floor * SWEEP_AB_SIGNIFICANCE_FACTOR;

  const note =
    verdict === 'unmeasured'
      ? 'At least one sweep pair had no resolvable baseline (see baselineOpenMs/baselineCloseMs on each summary), so this comparison has nothing to stand on.'
      : verdict === 'within-noise'
        ? `NO VERDICT: the all-off baseline moved ${baselineDeltaMs}ms between the two sweeps, which does not clear the conservative cross-run floor (${round2(floor)}ms x ${SWEEP_AB_SIGNIFICANCE_FACTOR}). That is "this comparison could not tell", not "no difference".`
        : `${verdict === 'pays-for-itself' ? 'PAYS FOR ITSELF' : 'COSTS MORE THAN IT SAVES'}: the all-off baseline (pure geometry/depth pipeline, no effects) is ${Math.abs(baselineDeltaMs)}ms ${baselineDeltaMs < 0 ? 'CHEAPER' : 'MORE EXPENSIVE'} with the toggle on, clearing the conservative cross-run floor (${round2(floor)}ms x ${SWEEP_AB_SIGNIFICANCE_FACTOR}). ` +
          (agree
            ? 'The all-on reading (full effect stack) agrees within noise — this is not an effect-stack artefact.'
            : `⚠️ The all-on reading disagrees: ${allOnDeltaMs}ms with the full effect stack active, vs ${baselineDeltaMs}ms on bare geometry. Something in the effect stack is coupled to this toggle — worth its own look before trusting the baseline reading alone.`);

  return { verdict, baselineDeltaMs, allOnDeltaMs, noiseFloorMs: floor, agreesWithAllOn: agree, perEffect, note };
}

/**
 * THE SWEEP, RUN TWICE — once per state of a structural (pipeline) toggle, so
 * the per-effect cost table and the scene-level baseline can be compared side
 * by side under both. Author's own words, in response to the report's first
 * early-Z verdict: *"Make the Early-Z part of the performance sweep. Make it
 * do something like an A/B - even doing the whole sweep twice in both
 * modes."*
 *
 * ============================================================================
 * WHY THIS EXISTS ALONGSIDE `perf-structural-ab.js`, NOT INSTEAD OF IT
 * ============================================================================
 *
 * `perf-structural-ab.js`'s A/B is per-ZONE, parked at one view, ON→OFF→ON in
 * one continuous window — fast (~1 minute total), same-run noise floor, but
 * only ever answers "what does the toggle cost on the route's own effect
 * mix, at one point on the map". This function answers a DIFFERENT question:
 * "does the toggle change what any INDIVIDUAL EFFECT costs, and what's the
 * cleanest possible reading of the toggle's own raw cost with every effect
 * stripped away" — using the sweep's existing per-effect on/off machinery,
 * unchanged, just run once per toggle state. Slower (two full sweeps, ~3-6
 * minutes total) and a weaker noise floor (see `compareSweepPair`'s own
 * header) — a second, independent instrument asking a related but different
 * question, not a faster or slower version of the same one.
 *
 * ALWAYS restores the toggle to whatever it was, even on a throw partway
 * through the second sweep — same discipline as `perf-structural-ab.js` and
 * for the same reason: a throw that left a live viewer's pipeline flipped
 * would surface as an unexplained rendering change hours later.
 *
 * @param {object} harness — the SAME sweep harness `runSweep` takes, PLUS
 *   `setStructuralToggle(id, on)` / `readStructuralToggle(id)`.
 * @param {string} toggleId — e.g. `'earlyZComposition'`.
 * @param {object} [opts] — forwarded to BOTH inner `runSweep` calls
 *   (settleFrames, feltFrames, gpuSampleTarget, warmupFrames, waitFrames…).
 *   `onProgress`, if given, receives the SAME `(phase, detail)` string pair
 *   `perf-session.js` uses elsewhere, not `runSweep`'s own richer per-config
 *   object shape — this function adapts one into the other so a caller does
 *   not need to know it is running the sweep twice.
 */
export async function runSweepStructuralAB(harness, toggleId, opts = {}) {
  const { onProgress = () => {}, waitFrames = defaultWaitFrames, ...sweepOpts } = opts;

  if (typeof harness?.setStructuralToggle !== 'function' || typeof harness?.readStructuralToggle !== 'function') {
    return {
      ran: false,
      skipped: 'harness-cannot-toggle',
      // Named, not shrugged at — a caller that asked for this and got nothing
      // must be able to tell "not supported" from "ran and found nothing".
      note: 'This harness exposes no setStructuralToggle/readStructuralToggle hook, so no A/B sweep is possible. That is a wiring gap, not a measurement result.',
      toggleId,
      on: null,
      off: null,
      comparison: null,
    };
  }
  const original = harness.readStructuralToggle(toggleId);
  if (typeof original !== 'boolean') {
    return {
      ran: false,
      skipped: 'toggle-not-readable',
      note: `The '${toggleId}' toggle could not be read back from this viewer, so it was never flipped — flipping it blind would leave nothing to restore it to.`,
      toggleId,
      on: null,
      off: null,
      comparison: null,
    };
  }

  // Settle-frames for THIS toggle, from the single catalog in
  // perf-structural-ab.js — falls back to a conservative default for a
  // toggle that hasn't been catalogued there yet, rather than refusing.
  const settleFrames = toggleById(toggleId)?.settleFrames ?? 120;

  const wrapProgress = (mode) => (p) => {
    const pos = Number.isFinite(p?.index) && p.index >= 0 ? ` (${p.index + 1}/${p.total})` : '';
    onProgress(
      `sweep-ab-${mode.toLowerCase()}`,
      `${toggleId} ${mode} — ${p?.label ?? ''}${pos}${p?.phase ? `, ${p.phase}` : ''}`
    );
  };

  let on = null;
  let off = null;
  try {
    onProgress('sweep-ab', `${toggleId} ON — settling ${settleFrames} frames, then the full effect sweep`);
    harness.setStructuralToggle(toggleId, true);
    await waitFrames(settleFrames);
    on = await runSweep(harness, { ...sweepOpts, waitFrames, onProgress: wrapProgress('ON') });

    onProgress('sweep-ab', `${toggleId} OFF — settling ${settleFrames} frames, then the full effect sweep`);
    harness.setStructuralToggle(toggleId, false);
    await waitFrames(settleFrames);
    off = await runSweep(harness, { ...sweepOpts, waitFrames, onProgress: wrapProgress('OFF') });
  } finally {
    // RESTORE, ALWAYS — outside the measurement try's own scope so it runs
    // even if arming/measuring itself threw partway through either sweep.
    harness.setStructuralToggle(toggleId, original);
  }

  return {
    ran: true,
    skipped: null,
    toggleId,
    liveState: original,
    settleFrames,
    on,
    off,
    comparison: compareSweepPair(on, off),
  };
}

// ---- UI (browser-verified) ----------------------------------------------
//
// Clipboard copy is no longer this file's job (2026-08-06): the sweep only ever runs
// as one phase of boot.js's combined action now, and every action already gets
// click→run→copy→status for free from debug-panel-controls.js's `makeRunnable` — a
// second copy of that logic here would just be a second place for it to drift.

/** The DOM's own placeholder text — extracted so `renderResult(null)` (nothing has run
 * yet) and the panel's initial state say the exact same thing, never two different
 * "nothing here" messages that could drift apart. */
const NO_RESULT_YET =
  'No sweep result yet — run "🔬 Performance Report" above. It runs this sweep as one ' +
  'half of a combined CPU + GPU measurement.';

/**
 * Create the embeddable per-effect GPU cost DISPLAY. Returns `{ el, renderResult,
 * setStatus }` — a plain (non-floating) DOM node the caller mounts wherever it likes,
 * plus two methods the caller drives from outside. Built eagerly, once, and the SAME
 * node every time — boot.js registers it via `registerPanel(id, label, () => perfLab.el,
 * {zone:'performance'})`, and debug-panel.js's Performance Center remounts that stable
 * reference on every repaint, so a result on screen survives an unrelated registration
 * elsewhere in the panel instead of vanishing.
 *
 * REFACTORED 2026-08-06 (twice the same day):
 *   1. From a `position:fixed` floating overlay (`{ open() }`) into a plain embeddable
 *      element — author directive: "move all performance monitoring things into a
 *      single space which becomes the only place for performance related tools". The
 *      logic above this point ALSO picked up its own fixes the same round (THIRD
 *      post-mortem, this file's header): sign-aware `resolved`, `suspiciousNegative`,
 *      `notes`, the warm-up phase, `context`.
 *   2. From a SELF-TRIGGERING panel (its own "Run sweep" button, calling `runSweep`
 *      itself) into a pure DISPLAY, no button, no `harness` param, driven entirely by
 *      `renderResult`/`setStatus` — author directive: "I don't want two separate
 *      buttons when a single report button would be more useful". The sweep now only
 *      ever runs as one phase of boot.js's single combined "🔬 Performance Report"
 *      action, alongside the per-zone CPU+GPU profile; this panel just shows whichever
 *      half of that combined result is its own.
 */
export function createPerfLab() {
  if (typeof document === 'undefined') {
    log.error('perf lab needs a DOM (no document) — returning a null element, not a floating panel to fall back to');
    return { el: null, renderResult: () => {}, setStatus: () => {} };
  }

  function el(tag, style, text) {
    const n = document.createElement(tag);
    if (style) Object.assign(n.style, style);
    if (text != null) n.textContent = text;
    return n;
  }

  const root = el('div', {
    width: '100%',
    background: '#12161c',
    color: '#dce3ea',
    font: '12px/1.45 ui-monospace, Menlo, Consolas, monospace',
    border: '1px solid rgba(143,214,255,0.25)',
    borderRadius: '10px',
    padding: '12px 14px',
    boxSizing: 'border-box',
  });

  const head = el('div', { fontWeight: 'bold', color: '#8fd6ff', marginBottom: '8px' }, '🔬 Per-effect GPU cost');
  root.appendChild(head);

  const status = el('div', { margin: '0 0 6px', minHeight: '16px', opacity: '0.85' }, '');
  root.appendChild(status);

  const results = el('div', { opacity: '0.6' }, NO_RESULT_YET);
  root.appendChild(results);

  /** Called by boot.js's combined action while the sweep phase is running. */
  function setStatus(text) {
    status.textContent = text ?? '';
  }

  /**
   * Called by boot.js's combined action once its sweep phase finishes. `summary`/
   * `context` are `runSweep`'s own return shape (`out.summary`, `out.context`) — the
   * SAME shape this panel already rendered when it triggered its own runs, so nothing
   * about `renderResults` below needed to change, only who calls it.
   * @param {object|null} summary - null clears back to the placeholder (e.g. the
   *   combined run failed before the sweep phase ever started).
   * @param {object|null} [context]
   */
  function renderResult(summary, context) {
    if (!summary) {
      results.textContent = '';
      results.style.opacity = '0.6';
      results.textContent = NO_RESULT_YET;
      return;
    }
    results.style.opacity = '1';
    renderResults(results, summary, context);
  }

  function renderResults(container, summary, context) {
    container.textContent = '';
    const budget = 8.33; // 120Hz frame budget; the line a frame must not cross to feel smooth

    // SESSION CONTEXT FIRST — so a screenshot or a pasted-back report says what it ran
    // against without anyone having to remember (2026-08-06: a live report reviewed with
    // no scene/floor/resolution attached at all — impossible to tell "faster" from
    // "lighter scene" a week later). Absent gracefully: an older/minimal harness without
    // getContext still renders the rest of the report exactly as before.
    if (context) {
      const c = el('div', { opacity: '0.6', marginBottom: '8px' });
      const res = context.resolution
        ? `${context.resolution.w}×${context.resolution.h}@${context.resolution.pixelRatio}x`
        : '—';
      c.textContent =
        `${context.sceneName ?? 'unknown scene'} · floor ${context.floorIndex ?? 0} · ${res} · ` +
        `v${context.msaVersion ?? '?'} · ${context.enabledEffects?.length ?? 0} effect(s) enabled`;
      container.appendChild(c);
    }

    // No inner "Per-effect GPU cost" heading here — the panel's own static header
    // (outside `renderResults`, built once in createPerfLab) already says that.
    const table = el('table', { width: '100%', borderCollapse: 'collapse' });
    table.appendChild(row(['Effect', 'GPU cost', '% of fx', 'P95'], true));
    if (summary.perEffect.length === 0) table.appendChild(row(['(no effects registered)', '', '', '']));
    for (const e of summary.perEffect) {
      const tr = row([e.label, formatCost(e), e.pctOfEffects == null ? '—' : `${e.pctOfEffects}%`, formatMs(e.gpuP95)]);
      tr.title = `n=${e.gpuSampleCount} GPU samples`; // low-confidence readings are visible on hover, not hidden
      if (e.suspiciousNegative) {
        // A DIFFERENT signal from "unresolved" — highlighted, not dimmed: this is the run's
        // own evidence saying something biased the measurement, worth a second look, not
        // just "not enough data".
        tr.style.color = '#ffcf7a';
      } else if (e.resolved === false) {
        // An unresolvable row is DIMMED, not deleted — the number stays readable, it just
        // stops competing for the eye with the ones the run can actually stand behind.
        tr.style.opacity = '0.45';
      }
      table.appendChild(tr);
    }
    container.appendChild(table);

    if (summary.notes?.length) {
      const notesBox = el('div', {
        marginTop: '6px',
        padding: '8px',
        background: 'rgba(255,207,122,0.08)',
        border: '1px solid rgba(255,207,122,0.25)',
        borderRadius: '6px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      });
      for (const n of summary.notes) notesBox.appendChild(el('div', { opacity: '0.85' }, n));
      container.appendChild(notesBox);
    }

    const floor = num(summary.noiseFloorMs);
    const unresolved = summary.perEffect.filter((e) => e.resolved === false).length;
    container.appendChild(
      el(
        'div',
        { opacity: '0.7', marginTop: '6px' },
        floor == null
          ? 'No repeat baseline in this run — the resolution floor is unknown, so treat every row above as unverified.'
          : `Noise floor ${formatMs(floor)} (measured: the same all-off scene re-run at the end drifted by ` +
              `${formatMs(summary.baselineDriftMs)}). ${unresolved} of ${summary.perEffect.length} effects are below it.`
      )
    );

    container.appendChild(el('div', { fontWeight: 'bold', margin: '12px 0 4px', color: '#8fd6ff' }, 'Scene'));
    const s = el('div', { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' });
    line(s, 'Base scene GPU', formatMs(summary.baseline.gpuMs));
    line(s, 'All effects GPU', formatMs(summary.all.gpuMs));
    line(s, 'Effect stack', formatMs(summary.totalEffectGpuMs));
    line(s, 'Frame (felt) P50', formatMs(summary.all.feltP50));
    line(s, 'Frame (felt) P95', formatMs(summary.all.feltP95));
    line(s, 'Foundry / other', formatOther(summary.impliedOtherMs));
    line(s, 'Hitches (felt)', summary.all.hitchCount == null ? '—' : String(summary.all.hitchCount));
    container.appendChild(s);
    container.appendChild(
      el(
        'div',
        { opacity: '0.6', marginTop: '4px' },
        `GPU readings: ${summary.baseline.gpuSampleCount} baseline / ${summary.all.gpuSampleCount} all-on samples.`
      )
    );

    const allGpu = num(summary.all.gpuMs);
    const verdict =
      allGpu == null
        ? 'GPU probe returned no samples — is the viewer running on WebGPU?'
        : allGpu <= budget
          ? `MSA's GPU work (${allGpu.toFixed(2)} ms/frame) fits inside the 8.33 ms/120fps budget — stutter is coming from elsewhere (see "Foundry / other").`
          : `MSA's GPU work (${allGpu.toFixed(2)} ms/frame) exceeds the 8.33 ms/120fps budget — this is a real per-frame cost, not a hitch.`;
    container.appendChild(
      el(
        'div',
        { marginTop: '10px', padding: '8px', background: '#1a2028', borderRadius: '6px', opacity: '0.95' },
        verdict
      )
    );

    // THE READING THAT WAS SILENTLY MISSING. When MSA's own GPU work exceeds the felt
    // frame gap, that gap is the rAF/display cadence with the queue absorbing the
    // overrun — NOT the rate frames actually reach the screen. Said plainly, because the
    // old panel's answer was to print an impossible negative "Foundry / other" instead.
    if (summary.feltUnderstated) {
      const felt = num(summary.all.feltP50);
      container.appendChild(
        el(
          'div',
          { marginTop: '8px', padding: '8px', background: '#2a2118', borderRadius: '6px', color: '#ffd08a' },
          `⚠️ Felt P50 (${formatMs(felt)}) is SHORTER than MSA's own GPU frame (${formatMs(allGpu)}), so it is not ` +
            `presentation time — frames are pipelining and the felt figure is the display's own cadence. Real ` +
            `throughput is nearer ${formatMs(allGpu)}/frame (~${Math.round(1000 / allGpu)} fps). "Foundry / other" ` +
            `cannot be derived in this regime and is suppressed rather than shown as a negative.`
        )
      );
    }
  }

  function row(cells, header) {
    const tr = document.createElement('tr');
    for (const c of cells) {
      const td = document.createElement(header ? 'th' : 'td');
      td.textContent = c;
      Object.assign(td.style, {
        textAlign: cells.indexOf(c) === 0 ? 'left' : 'right',
        padding: '3px 4px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        whiteSpace: 'nowrap',
        color: header ? '#9fb0c0' : 'inherit',
        fontWeight: header ? '600' : '400',
      });
      tr.appendChild(td);
    }
    return tr;
  }

  function line(grid, k, v) {
    const a = el('div', { opacity: '0.7' }, k);
    const b = el('div', { textAlign: 'right' }, v);
    grid.appendChild(a);
    grid.appendChild(b);
  }

  return { el: root, renderResult, setStatus };
}
