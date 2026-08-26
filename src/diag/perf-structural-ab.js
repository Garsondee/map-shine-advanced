/**
 * perf-structural-ab.js — DOES THIS PIPELINE CHOICE PAY FOR ITSELF?
 *
 * A structural toggle (early-Z composition, point-light batching) is not an
 * effect. An effect ADDS cost you can price by turning it off. A structural
 * toggle TRADES one cost for another — early-Z spends a whole extra geometry
 * submission to buy depth rejection in the main draw — and the only honest
 * answer to "was that worth it" is to measure both halves in both states.
 *
 * ============================================================================
 * WHY THIS EXISTS AS ITS OWN THING, AND NOT AS ANOTHER perf-lab SWEEP CONFIG
 * ============================================================================
 *
 * The effect sweep (perf-lab.js) diffs two WHOLE-FRAME GPU MEDIANS. That method
 * has a floor: it can only resolve an effect whose cost is large relative to the
 * entire frame. On the 2026-08-12 capture that floor came out at 7.3ms — derived
 * from the sweep's own most-negative reading, because a negative GPU cost is
 * impossible — and **all 15 of 15 effects fell inside it and were rejected.**
 * The sweep ran for minutes and produced not one usable number, for the third
 * capture running. That is not a tuning problem to be fixed with more frames;
 * it is the method being asked a question it cannot answer, because the effects
 * in question cost ~0.5ms each inside a ~70ms frame.
 *
 * This module asks a different question with a different instrument. It arms the
 * ZONE PROFILER in each state and diffs PER-ZONE GPU time. Two consequences:
 *
 *   1. **It is far finer.** A per-zone timestamp measures one pass directly
 *      instead of inferring it from the difference of two whole-frame numbers,
 *      so the noise it must beat is that pass's own variance, not the frame's.
 *
 *   2. **It says WHERE the time moved, not just whether it moved.** "Total GPU
 *      fell 4ms" is a result. "earlyZPrepass cost 18.1ms and worldDraw fell
 *      22.3ms in exchange" is an explanation, and it is the second one that
 *      tells you whether to keep the trade, tune it, or drop it.
 *
 * ============================================================================
 * THE THREE HONESTY RULES THIS FILE ADDS TO perf-report.js's FIVE
 * ============================================================================
 *
 * 1. **MEASURE THE NOISE IN THE SAME RUN, AND SAY SO.** Every toggle is
 *    measured ON → OFF → ON. The two ON blocks bracket the OFF block, and their
 *    disagreement IS this run's noise floor — GPU clocks ramp, thermals drift,
 *    and a difference smaller than that drift is not a result. A verdict is only
 *    issued when the delta clears the floor it was measured against. The effect
 *    sweep learned this the hard way (its own closing baseline differed from its
 *    opening one by 12.8ms, 10.6% of the baseline itself); this file is built
 *    around it from the start rather than discovering it per run.
 *
 * 2. **A PARKED CAMERA IS NOT THE ROUTE, AND THE REPORT MUST NOT PRETEND
 *    OTHERWISE.** This runs after the benchmark route completes, so it measures
 *    one static view. That is deliberate — camera motion is the single largest
 *    source of frame-to-frame variance, and removing it is most of why this can
 *    resolve what the sweep cannot. But a view-dependent trade (and early-Z is
 *    exactly that: it pays off in proportion to overdraw, which depends where
 *    you are standing) can differ elsewhere on the map. So every result carries
 *    a REPRESENTATIVENESS CHECK: the ON-state zone numbers measured here are
 *    compared against the same zones' numbers from the main route window, which
 *    the caller already has. If they agree, this view stands in for the route.
 *    If they do not, the report says the verdict is local to this view and
 *    declines to generalise it.
 *
 * 3. **RESTORE IN A `finally`, ALWAYS.** This flips real pipeline state on a
 *    live viewer. A throw mid-measurement that left early-Z off would look like
 *    a rendering regression appearing from nowhere, hours later, with no clue
 *    pointing back here.
 *
 * ============================================================================
 * 2026-08-26 — MULTIPLE CYCLES, AN AMBIENT-NOISE PRE-CHECK, A SECOND TOGGLE
 * ============================================================================
 *
 * Added at the author's own direction ("add more settle time if that helps")
 * after `earlyZComposition` came back `within-noise` on real map content in
 * every live capture that ever tried it there. Three additions, all opt-in at
 * the library level (a caller passing no new opts gets byte-identical
 * behaviour to before this date — see `buildAbSequence`/`aggregateAbCycles`'s
 * own doc for the proof), on by default at the `perf-run-full` call site:
 *
 * - **Multiple ON→OFF→ON cycles** (`cycles` opt) — more independent samples of
 *   the same trade, sharing each cycle's closing ON block with the next
 *   cycle's opening one, the same efficiency trick the original on1/on2
 *   averaging already used. The combined delta AVERAGES across cycles; the
 *   combined noise floor does NOT — see `aggregateAbCycles`'s own header for
 *   why an average there would manufacture false confidence.
 * - **An ambient-noise pre-check** (`measureAmbientNoiseFloor`, on by default)
 *   — measures whatever state the viewer is ALREADY in, twice back to back,
 *   with no toggle touched at all. Its own disagreement is this run's ambient
 *   jitter, independent of any one toggle's settle mechanics, so every
 *   toggle's own floor can be read against it.
 * - **`pointLightBatching`** joins `STRUCTURAL_TOGGLES` — Stage 2's own formal
 *   acceptance gate (S2.9, "does batching pay for itself") was designed but
 *   never actually run; this closes that gap using the same mechanism
 *   `earlyZComposition` already proved out, since the flag is the same live,
 *   per-frame-read shape (confirmed against `vt-pan-viewer.js` directly, not
 *   guessed) — no residency nudge needed, unlike earlyZComposition.
 *
 * @module diag/perf-structural-ab
 */

/** ON → OFF → ON. The two ON blocks bracket OFF so their drift measures the run. */
export const AB_SEQUENCE = Object.freeze(['on', 'off', 'on']);

/** Frames discarded after a toggle flips, before measurement starts. */
export const DEFAULT_AB_SETTLE_FRAMES = 60;
/** Frames measured per state. Raised 180→300 (2026-08-26): more independent
 * frame samples of the same steady state shrinks the standard error of each
 * block's own mean directly — this does not fix systematic drift (that's what
 * `cycles`/the ambient check target), only per-block sampling noise. */
export const DEFAULT_AB_MEASURE_FRAMES = 300;
/** How many ON→OFF→ON cycles `runStructuralAB` walks by default, when the
 * caller passes no `cycles` opt. Kept at 1 — byte-identical to the original
 * single-cycle behaviour — so every existing caller/test is unaffected; the
 * `perf-run-full` call site opts into more (2) explicitly, the same shape
 * `settleFrames: 90` already uses there over the library's own default. */
export const DEFAULT_AB_CYCLES = 1;
/**
 * A delta must clear the measured noise floor by this factor to earn a verdict.
 * 1.0 would call a delta exactly equal to the run's own drift a result.
 */
export const AB_SIGNIFICANCE_FACTOR = 1.5;
/**
 * ON-state zone totals this far from the route's own numbers mean the parked
 * view is not standing in for the route, and the verdict must not generalise.
 */
export const AB_REPRESENTATIVE_TOLERANCE = 0.35;

/**
 * THE CATALOG. Kept here rather than in boot so it is Node-testable and so each
 * toggle's QUESTION travels with it — a toggle whose result nobody can interpret
 * is a number, not an answer.
 *
 * `watchZones` are the zones whose movement explains the trade. They are not a
 * filter (every zone is diffed and reported); they are what the summary leads
 * with, because a 40-row table with no pointer is another thing that gets
 * skimmed past.
 */
export const STRUCTURAL_TOGGLES = Object.freeze([
  Object.freeze({
    id: 'earlyZComposition',
    label: 'Early-Z composition (Stage 1, "shade once")',
    question:
      'Stage 1 renders the opaque proxy geometry a SECOND time into scene.color to buy EQUAL-depth rejection in the main world draw. Does the rejection it buys cost less than the extra submission it pays?',
    // Both sides of the trade, plus the depth pass they share geometry with.
    watchZones: Object.freeze([
      'geometry.earlyZPrepass',
      'geometry.worldDraw',
      'geometry.depthDraw',
      'geometry.depthRenderCall',
    ]),
    // ⚠️ LONGER THAN THE DEFAULT ON PURPOSE. setEarlyZComposition only takes
    // effect on the NEXT residency pass (it calls scheduleResidencyUpdate and
    // returns; the prepass mesh set is rebuilt there, not synchronously). A
    // short settle would measure a state that has not finished changing —
    // the `feedback_arm_once_call_races_lazy_singleton` shape.
    settleFrames: 120,
  }),
  Object.freeze({
    id: 'pointLightBatching',
    label: 'Point-light batching (Stage 2)',
    question:
      'Stage 2 merges lights sharing a compiled material into ONE drawn mesh per (bucket × channel) instead of one draw per light. Does the batching/reconcile overhead cost less than the draw calls it removes?',
    watchZones: Object.freeze([
      // The batching bookkeeping's OWN cost, zoned separately from the
      // draw-call reduction it's meant to buy — perf-zones.js's own
      // declaration: "so its own overhead should be independently visible and
      // comparable, not folded into the loop it is meant to be cheaper than."
      'light.pointLightBatchReconcile',
      // The unbatched per-light path — should shrink as more lights admit
      // into buckets.
      'light.pointLightReconcile',
      // The actual draws, batched or not — both channels share these zones.
      'light.drawPointLights',
      'light.drawColoration',
    ]),
    // NO settleFrames override, unlike earlyZComposition — point-light-pool.js
    // #update() re-reads the flag fresh every frame (confirmed at
    // vt-pan-viewer.js's own `setPointLightBatching` doc: "No residency nudge
    // needed... runs every frame regardless and will read the new value on
    // its very next call"), so the default settle is already enough.
  }),
]);

/** @param {string} id @returns {object|null} */
export function toggleById(id) {
  return STRUCTURAL_TOGGLES.find((t) => t.id === id) ?? null;
}

/**
 * Build the ON/OFF walk for N cycles. `cycles:1` reproduces `AB_SEQUENCE`
 * exactly (`['on','off','on']`) — this is not a special case, it is just N=1
 * of the general pattern. `cycles:2` walks `['on','off','on','off','on']`,
 * SHARING the middle 'on' block between both cycles — the same efficiency
 * trick the original on1/on2 averaging already relied on, extended.
 * @param {number} [cycles]
 * @returns {string[]}
 */
export function buildAbSequence(cycles = DEFAULT_AB_CYCLES) {
  const n = Math.max(1, Math.floor(cycles) || 1);
  const seq = ['on'];
  for (let i = 0; i < n; i++) seq.push('off', 'on');
  return seq;
}

/**
 * Fold one armed-and-measured window down to the numbers an A/B needs.
 * Zone GPU is amortised per frame so two blocks of different lengths compare.
 */
export function summariseAbBlock({ profile = null, gpuStatus = null } = {}) {
  const frames = Number.isFinite(profile?.frames) ? profile.frames : 0;
  const zones = {};
  let attributed = 0;
  for (const z of profile?.zoneStats ?? []) {
    if (!z?.gpu || !Number.isFinite(z.gpu.sumMs) || !(frames > 0)) continue;
    const perFrame = z.gpu.sumMs / frames;
    zones[z.id] = perFrame;
    attributed += perFrame;
  }
  const frameGpuMs = Number.isFinite(gpuStatus?.frameGpuMs?.p50) ? gpuStatus.frameGpuMs.p50 : null;
  return {
    frames,
    // Null, never 0, when nothing was measured — an absence must not read as a
    // free frame (perf-report.js rule 1, which applies just as hard here).
    frameGpuMs,
    attributedGpuMs: Object.keys(zones).length > 0 ? attributed : null,
    gpuSampleCount: gpuStatus?.frameGpuMs?.sampleCount ?? null,
    zones,
  };
}

const round = (v, dp) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const ms = (v) => round(v, 3);

/**
 * Turn the three measured blocks into a verdict, or into an honest refusal.
 *
 * @param {object} args
 * @param {object} args.on1 first ON block
 * @param {object} args.off the OFF block
 * @param {object} args.on2 second ON block — its disagreement with on1 is the floor
 * @param {string[]} args.watchZones
 * @param {Record<string, number>|null} args.routeZones the main window's own
 *   per-frame zone GPU, for the representativeness check. Null skips the check
 *   and says so, rather than silently asserting the view is representative.
 */
export function compareAbBlocks({ on1, off, on2, watchZones = [], routeZones = null } = {}) {
  const pick = (b) => (Number.isFinite(b?.attributedGpuMs) ? b.attributedGpuMs : null);
  const a1 = pick(on1);
  const a2 = pick(on2);
  const aOff = pick(off);
  if (a1 === null || aOff === null || a2 === null) {
    return {
      verdict: 'unmeasured',
      onGpuMs: ms(a1),
      offGpuMs: ms(aOff),
      deltaGpuMs: null,
      noiseFloorMs: null,
      perZone: [],
      representative: null,
      note:
        'At least one of the three A/B blocks produced no attributed GPU time at all, so no comparison is possible. ' +
        'This is an ABSENCE, not a "no difference" result — check that GPU timestamp queries were available.',
    };
  }

  // The floor is the drift between two measurements of the SAME state. Anything
  // this run cannot distinguish from that is not a finding.
  const noiseFloorMs = Math.abs(a1 - a2);
  // Both ON readings averaged — using only the first would hand the whole drift
  // to the OFF comparison rather than splitting it as the sequence intends.
  const onGpuMs = (a1 + a2) / 2;
  const deltaGpuMs = onGpuMs - aOff;
  const significant = Math.abs(deltaGpuMs) > noiseFloorMs * AB_SIGNIFICANCE_FACTOR;

  const ids = new Set([...watchZones, ...Object.keys(on1.zones ?? {}), ...Object.keys(off.zones ?? {})]);
  const perZone = [...ids]
    .map((id) => {
      const onMs = ((on1.zones?.[id] ?? 0) + (on2.zones?.[id] ?? 0)) / 2;
      const offMs = off.zones?.[id] ?? 0;
      return {
        id,
        watched: watchZones.includes(id),
        onMs: ms(onMs),
        offMs: ms(offMs),
        deltaMs: ms(onMs - offMs),
      };
    })
    // Biggest MOVER first — a zone that did not change is not what anyone opened
    // this table to read.
    .sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs));

  // RULE 2: is this parked view standing in for the route at all?
  let representative = null;
  if (routeZones && watchZones.length > 0) {
    const cmp = watchZones
      .map((id) => {
        // ⚠️ PARENTHESISE BOTH ?? BEFORE ADDING. `+` binds tighter than `??`, so
        // `a ?? 0 + (b ?? 0)` parses as `a ?? (0 + b)` — which silently returns
        // the FIRST block alone whenever it is present, and the second alone
        // when it is not. A wrong number that looks entirely plausible.
        const here = ((on1.zones?.[id] ?? 0) + (on2.zones?.[id] ?? 0)) / 2;
        const there = routeZones[id];
        if (!Number.isFinite(there) || there <= 0) return null;
        return { id, abMs: ms(here), routeMs: ms(there), ratio: round(here / there, 2) };
      })
      .filter(Boolean);
    const diverging = cmp.filter((c) => Math.abs(c.ratio - 1) > AB_REPRESENTATIVE_TOLERANCE).map((c) => c.id);
    representative = {
      checked: cmp.length,
      diverging,
      zones: cmp,
      verdict: cmp.length === 0 ? 'unknown' : diverging.length === 0 ? 'representative' : 'view-local',
      note:
        cmp.length === 0
          ? 'None of the watched zones could be compared against the route window, so whether this parked view stands in for the route is UNKNOWN — not assumed.'
          : diverging.length === 0
            ? 'The watched zones cost the same here as they did across the whole route, so this parked view is standing in for the route and the verdict below generalises to it.'
            : `${diverging.join(', ')} cost materially differently here than across the route, so this parked view is NOT representative of it. The verdict below is TRUE OF THIS VIEW and must not be generalised to the map — re-run the A/B parked somewhere with different overdraw before deciding anything permanent.`,
    };
  }

  return {
    verdict: !significant ? 'within-noise' : deltaGpuMs < 0 ? 'pays-for-itself' : 'costs-more-than-it-saves',
    onGpuMs: ms(onGpuMs),
    offGpuMs: ms(aOff),
    deltaGpuMs: ms(deltaGpuMs),
    noiseFloorMs: ms(noiseFloorMs),
    significanceFactor: AB_SIGNIFICANCE_FACTOR,
    onBlocks: [ms(a1), ms(a2)],
    perZone,
    representative,
    note: !significant
      ? `NO VERDICT: the ON/OFF difference (${ms(Math.abs(deltaGpuMs))}ms) does not clear this run's own noise floor (${ms(noiseFloorMs)}ms, measured from the two ON blocks bracketing the OFF one) by the required ${AB_SIGNIFICANCE_FACTOR}×. That is not "no difference" — it is "this run could not tell". Re-run on an idle machine, or with more measure frames, before concluding either way.`
      : deltaGpuMs < 0
        ? `PAYS FOR ITSELF: ${ms(Math.abs(deltaGpuMs))}ms/frame CHEAPER with it on (${ms(onGpuMs)}ms vs ${ms(aOff)}ms), clearing the ${ms(noiseFloorMs)}ms noise floor. perZone below shows which zone gave the time back.`
        : `COSTS MORE THAN IT SAVES: ${ms(deltaGpuMs)}ms/frame MORE EXPENSIVE with it on (${ms(onGpuMs)}ms vs ${ms(aOff)}ms), clearing the ${ms(noiseFloorMs)}ms noise floor. perZone below shows what it added and what (if anything) it gave back.`,
  };
}

/**
 * Combine 1+ independent `{on1,off,on2}` windows into one verdict.
 *
 * **For a single window this returns EXACTLY `compareAbBlocks(window)`, plus
 * a `cycles` field** — `cycles:1` is not a special case internally, it is
 * just this general path with one window, which is what makes raising
 * `DEFAULT_AB_CYCLES` later a safe, purely-additive change: every existing
 * caller already gets this function's single-window branch today, unlabelled.
 *
 * For multiple windows, the delta AVERAGES across them — legitimate, since
 * each window is an independent sample of the same underlying trade, and
 * averaging independent samples of the same quantity tightens the estimate.
 * **The noise floor does NOT average.** It is `Math.max` of (a) the mean of
 * each window's own on1-vs-on2 bracket and (b) the SPREAD between the
 * windows' own deltas. If repeated windows disagree with each other by more
 * than any single window's own bracket suggested, that disagreement IS the
 * more honest floor — silently shrinking it via averaging would manufacture
 * false confidence, exactly the failure this file's own header already
 * guards against for the single-window case (rule 1).
 */
export function aggregateAbCycles({ windows = [], watchZones = [], routeZones = null } = {}) {
  const list = Array.isArray(windows) ? windows.filter(Boolean) : [];
  if (list.length === 0) {
    return {
      verdict: 'unmeasured',
      onGpuMs: null,
      offGpuMs: null,
      deltaGpuMs: null,
      noiseFloorMs: null,
      perZone: [],
      representative: null,
      perCycle: [],
      note: 'No A/B windows were measured at all, so no comparison is possible.',
    };
  }

  const perCycle = list.map((w) => compareAbBlocks({ ...w, watchZones, routeZones }));
  if (perCycle.length === 1) return { ...perCycle[0], perCycle };

  const measured = perCycle.filter((c) => Number.isFinite(c.deltaGpuMs));
  if (measured.length === 0) {
    return {
      verdict: 'unmeasured',
      onGpuMs: null,
      offGpuMs: null,
      deltaGpuMs: null,
      noiseFloorMs: null,
      perZone: [],
      representative: null,
      perCycle,
      note: `Every one of ${perCycle.length} A/B cycles this run attempted came back unmeasured — see perCycle[] for which block was missing in each.`,
    };
  }

  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const deltaGpuMs = ms(avg(measured.map((c) => c.deltaGpuMs)));
  const onGpuMs = ms(avg(measured.map((c) => c.onGpuMs)));
  const offGpuMs = ms(avg(measured.map((c) => c.offGpuMs)));
  const withinCycleFloor = avg(measured.map((c) => c.noiseFloorMs ?? 0));
  const crossCycleSpread =
    measured.length > 1
      ? Math.max(...measured.map((c) => c.deltaGpuMs)) - Math.min(...measured.map((c) => c.deltaGpuMs))
      : 0;
  // ⚠️ Math.max, NEVER an average and never the smaller of the two — see this
  // function's own header. A combined floor smaller than either honest
  // component would be a shrunk floor manufacturing a verdict neither
  // component earned on its own.
  const noiseFloorMs = ms(Math.max(withinCycleFloor, crossCycleSpread));
  const significant = Math.abs(deltaGpuMs) > noiseFloorMs * AB_SIGNIFICANCE_FACTOR;

  // Per-zone: average each zone's onMs/offMs/deltaMs across the cycles that
  // actually reported it, same "biggest mover first" sort as compareAbBlocks.
  const zoneIds = new Set(measured.flatMap((c) => c.perZone.map((z) => z.id)));
  const perZone = [...zoneIds]
    .map((id) => {
      const rows = measured.map((c) => c.perZone.find((z) => z.id === id)).filter(Boolean);
      const avgField = (key) => ms(avg(rows.map((r) => r[key] ?? 0)));
      return {
        id,
        watched: watchZones.includes(id),
        onMs: avgField('onMs'),
        offMs: avgField('offMs'),
        deltaMs: avgField('deltaMs'),
      };
    })
    .sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs));

  // Representativeness: every cycle flips the SAME toggle against the SAME
  // routeZones, so they agree by construction — reuse the first measured
  // cycle's own check rather than recomputing (and re-printing) the same
  // answer `measured.length` times.
  const representative = measured[0].representative;

  return {
    verdict: !significant ? 'within-noise' : deltaGpuMs < 0 ? 'pays-for-itself' : 'costs-more-than-it-saves',
    onGpuMs,
    offGpuMs,
    deltaGpuMs,
    noiseFloorMs,
    significanceFactor: AB_SIGNIFICANCE_FACTOR,
    perZone,
    representative,
    perCycle,
    note: !significant
      ? `NO VERDICT across ${measured.length} cycles: the averaged ON/OFF difference (${ms(Math.abs(deltaGpuMs))}ms) does not clear the combined noise floor (${ms(noiseFloorMs)}ms — the larger of the average within-cycle drift and the spread between cycles' own deltas) by the required ${AB_SIGNIFICANCE_FACTOR}×. Re-run with more cycles or more measured frames before concluding either way.`
      : deltaGpuMs < 0
        ? `PAYS FOR ITSELF across ${measured.length} cycles: ${ms(Math.abs(deltaGpuMs))}ms/frame cheaper on average (${onGpuMs}ms vs ${offGpuMs}ms), clearing the ${ms(noiseFloorMs)}ms combined noise floor.`
        : `COSTS MORE THAN IT SAVES across ${measured.length} cycles: ${ms(deltaGpuMs)}ms/frame more expensive on average (${onGpuMs}ms vs ${offGpuMs}ms), clearing the ${ms(noiseFloorMs)}ms combined noise floor.`,
  };
}

/**
 * How much does THIS machine jitter right now, with no toggle touched at
 * all? Measures whatever state is already live, twice back to back, using
 * the exact same settle→arm→measure shape every toggle block already uses.
 * The two readings' disagreement is this run's own ambient noise — a rough
 * "how noisy is the machine right now" signal every toggle's own floor can
 * be read against, not a fixed baseline (it measures whichever state
 * happens to be live when the run starts, so it is not strictly comparable
 * across two runs that started from different live states — see its own
 * `note`).
 *
 * Deliberately cheap and run ONCE per `runStructuralAB()` call, before any
 * toggle is touched — reuses the harness's own `armProfiler`/`waitFrames`/
 * `setGpuZoneTimer`/`readProfile`/`getGpuZoneStatus`/`disarmProfiler`, the
 * same contract every toggle block already depends on, so no new harness
 * method is required of any caller.
 *
 * @param {object} harness the same profile harness `perf-session.js` uses
 * @param {object} [opts]
 * @param {number} [opts.settleFrames]
 * @param {number} [opts.measureFrames]
 */
export async function measureAmbientNoiseFloor(harness, { settleFrames = 30, measureFrames = 120 } = {}) {
  harness.resetFrameStats?.();
  harness.armProfiler({ settleFrames });
  let a = null;
  let b = null;
  try {
    await harness.waitFrames(settleFrames);
    const timer1 = harness.setGpuZoneTimer(true);
    try {
      await harness.waitFrames(measureFrames);
      a = summariseAbBlock({ profile: harness.readProfile(), gpuStatus: harness.getGpuZoneStatus() });
      a.gpuTimer = timer1 ?? null;
    } finally {
      harness.setGpuZoneTimer(false);
    }
    // Second reading, same armed window — no re-settle, this is deliberately
    // "right after" the first, not a second independent arm.
    harness.resetFrameStats?.();
    const timer2 = harness.setGpuZoneTimer(true);
    try {
      await harness.waitFrames(measureFrames);
      b = summariseAbBlock({ profile: harness.readProfile(), gpuStatus: harness.getGpuZoneStatus() });
      b.gpuTimer = timer2 ?? null;
    } finally {
      harness.setGpuZoneTimer(false);
    }
  } finally {
    harness.disarmProfiler();
  }

  const av = Number.isFinite(a?.attributedGpuMs) ? a.attributedGpuMs : null;
  const bv = Number.isFinite(b?.attributedGpuMs) ? b.attributedGpuMs : null;
  if (av === null || bv === null) {
    return {
      measured: false,
      ambientNoiseMs: null,
      note: 'At least one ambient-check block produced no attributed GPU time, so ambient jitter could not be measured this run — this is an ABSENCE, not "zero jitter".',
    };
  }
  return {
    measured: true,
    ambientNoiseMs: ms(Math.abs(av - bv)),
    aGpuMs: ms(av),
    bGpuMs: ms(bv),
    settleFrames,
    measureFrames,
    note:
      'Two back-to-back measurements of whatever state was live when this run started, with no toggle flipped. ' +
      "Their disagreement is this run's own ambient jitter. A rough baseline, not a fixed one — it reflects " +
      'whichever state happened to be live, so is not strictly comparable to this same field from a run that ' +
      'started with a different live toggle state.',
  };
}

/**
 * Run the A/B live. Sequential and slow by nature — each block needs its own
 * settle and its own armed window — but bounded and announced.
 *
 * @param {object} harness the same profile harness `perf-session.js` uses
 * @param {object} [opts]
 * @param {string[]} [opts.toggleIds] which toggles to run; defaults to every one
 *   the harness reports it can actually flip
 * @param {Record<string, number>|null} [opts.routeZones] main-window per-frame
 *   zone GPU, for the representativeness check
 * @param {number} [opts.measureFrames]
 * @param {number} [opts.cycles] how many ON→OFF→ON cycles to walk per toggle —
 *   see `buildAbSequence`/`aggregateAbCycles`. Defaults to 1 (unchanged
 *   behaviour for any existing caller).
 * @param {boolean} [opts.includeAmbientCheck] run `measureAmbientNoiseFloor`
 *   once before the toggle loop. Defaults to true — cheap (~2s) relative to
 *   what it answers.
 */
export async function runStructuralAB(harness, opts = {}) {
  const {
    toggleIds = null,
    routeZones = null,
    measureFrames = DEFAULT_AB_MEASURE_FRAMES,
    cycles = DEFAULT_AB_CYCLES,
    includeAmbientCheck = true,
    onProgress = null,
  } = opts;

  const say = (phase, detail) => {
    if (typeof onProgress === 'function') onProgress(phase, detail);
  };

  if (typeof harness?.setStructuralToggle !== 'function' || typeof harness?.readStructuralToggle !== 'function') {
    return {
      ran: false,
      skipped: 'harness-cannot-toggle',
      // Named, not shrugged at: a caller that requested this and got nothing
      // must be able to tell "not supported" from "ran and found nothing".
      note: 'This harness exposes no setStructuralToggle/readStructuralToggle hook, so no structural A/B is possible. That is a wiring gap, not a measurement result.',
      toggles: [],
    };
  }

  const wanted = (toggleIds ? STRUCTURAL_TOGGLES.filter((t) => toggleIds.includes(t.id)) : STRUCTURAL_TOGGLES).filter(
    (t) => {
      const cur = harness.readStructuralToggle(t.id);
      // A toggle the viewer cannot report on is one we must not flip blind —
      // we would have nothing to restore it to.
      return cur !== null && cur !== undefined && typeof cur === 'boolean';
    }
  );

  if (wanted.length === 0) {
    return {
      ran: false,
      skipped: 'no-readable-toggles',
      note: 'No structural toggle in the catalog could be read back from this viewer, so none was flipped — flipping one without a known original state risks leaving the renderer in it.',
      toggles: [],
    };
  }

  // AMBIENT-NOISE PRE-CHECK (2026-08-26) — see measureAmbientNoiseFloor's own
  // header. Runs BEFORE any toggle is touched (so it reads whatever state the
  // viewer was already in) and before hideLiveUi (so its own cost is visible
  // like any other measurement, not hidden). Optional only in the sense that
  // a harness with no armProfiler could not run it — every real harness has
  // one, this guard exists only for a minimal test double.
  let ambientCheck = null;
  if (includeAmbientCheck && typeof harness.armProfiler === 'function') {
    say('structural-ab', 'ambient noise pre-check (no toggle flipped)');
    try {
      ambientCheck = await measureAmbientNoiseFloor(harness);
    } catch (err) {
      ambientCheck = {
        measured: false,
        ambientNoiseMs: null,
        note: `ambient pre-check threw, continuing without it: ${err?.message ?? err}`,
      };
    }
  }

  // ⚠️ THE LIVE HUD WILL FIGHT THIS FOR THE PROFILER IF IT IS VISIBLE.
  //
  // `runProfileSession` hides the debug UI for the ROUTE and restores it in its
  // own `finally` — which runs BEFORE this does. So by the time the A/B starts,
  // the panel is back, and the perf HUD re-arms the profiler as owner `'hud'`
  // roughly four times a second to keep its rolling window alive. Two things
  // then go wrong at once: `frame-profiler.arm()` THROWS on an owner mismatch
  // (deliberately — that error names this exact 2026-07-27 incident, where a
  // profile session timed out at "only 4 frames counted" because the HUD was
  // resetting the counter four times a second), and even without the throw,
  // every HUD re-arm would reset the block mid-measurement.
  //
  // The effect sweep does not hit this because it never arms the profiler — it
  // uses the whole-frame GPU probe. This module does, so it must take the UI
  // down for its own duration and put it back afterwards. Optional hooks, same
  // as everywhere else in the harness contract: a caller without them (every
  // test fake) simply measures with the UI as it finds it.
  harness.hideLiveUi?.();

  const sequence = buildAbSequence(cycles);
  const results = [];
  try {
    for (const toggle of wanted) {
      const original = harness.readStructuralToggle(toggle.id);
      const settleFrames = toggle.settleFrames ?? DEFAULT_AB_SETTLE_FRAMES;
      // An ORDERED array, not a fixed {on1,off,on2} object — walks whatever
      // length `sequence` is, one measured block per step, in order. Cycle i's
      // window slides across it: {on1:blocksArray[2i], off:blocksArray[2i+1],
      // on2:blocksArray[2i+2]} — see the window-derivation just below the loop.
      const blocksArray = [];
      try {
        for (let step = 0; step < sequence.length; step++) {
          const state = sequence[step];
          const on = state === 'on';
          say('structural-ab', `${toggle.label} — ${state.toUpperCase()} (${step + 1}/${sequence.length})`);
          harness.setStructuralToggle(toggle.id, on);
          harness.resetFrameStats();
          // ⚠️ ARM BEFORE WAITING, ALWAYS — fixed 2026-08-12 after a live
          // failure. `waitFrames` (perf-session.js's `createProfiledFrameWaiter`)
          // polls `readProfile().frames + .settleFramesDiscarded`, and NEITHER
          // number advances unless the profiler is armed and receiving
          // `beginFrame`/`endFrame` from the real render loop. The first cut of
          // this function called `waitFrames(settleFrames)` for the toggle's
          // settle period BEFORE this `armProfiler` call — at that moment the
          // profiler was still disarmed (the main window's own teardown runs
          // before this function is ever reached), so the poll's `seen` could
          // never leave 0 no matter how many real frames rendered. Every run
          // timed out at 30s with "waited 30s for 120 frames but only 0 were
          // counted" — that error's own wording blames the viewer, on a viewer
          // that was rendering perfectly.
          //
          // The fix is to arm ONCE per block with the settle count baked in,
          // exactly like `perf-session.js`'s own main window
          // (`armProfiler({settleFrames})` immediately followed by
          // `waitFrames(settleFrames)`), and let both the settle wait and the
          // measurement wait run inside that one continuously-armed window.
          // `waitFrames` is incremental — each call snapshots its own starting
          // count — so calling it twice in a row against one armed window is
          // exactly the pattern the main session already relies on, not a new
          // one invented here.
          harness.armProfiler({ settleFrames });
          try {
            await harness.waitFrames(settleFrames);
            // Kept, not discarded: `{skipped: true, reason}` here is why a
            // block came back with no GPU numbers, and losing it turns a
            // diagnosable wiring problem into an unexplained null three layers
            // up.
            const timer = harness.setGpuZoneTimer(true);
            try {
              await harness.waitFrames(measureFrames);
              const block = summariseAbBlock({
                profile: harness.readProfile(),
                gpuStatus: harness.getGpuZoneStatus(),
              });
              block.gpuTimer = timer ?? null;
              blocksArray.push(block);
            } finally {
              harness.setGpuZoneTimer(false);
            }
          } finally {
            harness.disarmProfiler();
          }
        }
      } finally {
        // RULE 3. Non-negotiable, and outside the measurement try so it runs even
        // if arming itself threw.
        harness.setStructuralToggle(toggle.id, original);
      }

      const windows = [];
      for (let i = 0; i + 2 < blocksArray.length; i += 2) {
        windows.push({ on1: blocksArray[i], off: blocksArray[i + 1], on2: blocksArray[i + 2] });
      }
      const combined = aggregateAbCycles({ windows, watchZones: toggle.watchZones, routeZones });

      results.push({
        id: toggle.id,
        label: toggle.label,
        question: toggle.question,
        liveState: original,
        settleFrames,
        measureFrames,
        cycles: windows.length,
        blocks: blocksArray,
        // How this toggle's own combined floor compares to the machine's
        // ambient jitter (measured once, above, before any toggle moved).
        // ~1 => the machine itself is the limiting factor; well above 1 =>
        // this toggle's own settle mechanics are adding variance beyond
        // ambient, worth a look. Null when either side is unmeasured.
        noiseFloorVsAmbientRatio:
          Number.isFinite(combined.noiseFloorMs) &&
          Number.isFinite(ambientCheck?.ambientNoiseMs) &&
          ambientCheck.ambientNoiseMs > 0
            ? round(combined.noiseFloorMs / ambientCheck.ambientNoiseMs, 2)
            : null,
        ...combined,
      });
    }
  } finally {
    // Paired with hideLiveUi above, and unconditional: a throw partway through
    // must not leave the author's debug panel gone with no way to tell why.
    harness.restoreLiveUi?.();
  }

  return {
    ran: true,
    skipped: null,
    method: `${sequence.join('→')}, ${measureFrames} measured frames per block, profiler armed per block${
      cycles > 1 ? ` (${cycles} cycles)` : ''
    }`,
    cameraNote:
      "Measured with the camera PARKED at wherever the benchmark route ended, not moving along it. That removes camera motion — the largest source of frame-to-frame variance, and most of why this resolves what the whole-frame effect sweep cannot — at the cost of measuring one view rather than the map. See each toggle's `representative` block for whether that view stood in for the route.",
    ambientCheck,
    toggles: results,
  };
}

/**
 * ============================================================================
 * EDITING-CADENCE STRESS TEST (2026-08-26) — DOES AN UNRELATED EDIT FORCE A
 * REAL REBAKE?
 * ============================================================================
 *
 * `boot.js`'s `redrawOn(hook)` registers an ARITY-1 Foundry hook callback —
 * `Hooks.on(hook, (doc) => {...})` — that discards the real
 * `(document, change, options, userId)` signature Foundry actually calls it
 * with. So any write to any Tile/Level document, REGARDLESS OF WHAT CHANGED,
 * runs `refreshMaskAuthorityItems`, which re-collects the mask authority's
 * whole item set and calls `maskAuthority.setItems(...)` unconditionally.
 *
 * `refreshMaskAuthorityItems` itself has NO zone — it runs from a Foundry hook
 * callback, off the render loop entirely, never from inside any per-frame
 * profiled pass, so the zone profiler is structurally blind to its own CPU
 * cost. What the profiler CAN see, and what this function watches instead: the
 * downstream subsystems whose own 'bake' gate reads a mask-authority VERSION
 * counter. Source-verified, not assumed — `sun-shadow-subsystem.js:1368`:
 * `version = getMaskAuthorityVersion(); versionChanged = !casterFieldLoaded ||
 * version !== casterFieldVersion;` and `versionChanged` alone forces
 * `needsBake`. If `setItems` bumps that counter on every call — which an
 * unconditional re-collection, called on every edit no matter how irrelevant,
 * would do — every one of those subsystems re-bakes on the next frame whether
 * or not anything it actually cares about changed. `EDIT_CASCADE_WATCH_ZONES`
 * below is every 'bake'-cadence zone perf-zones.js declares that is reachable
 * this way. Fire is deliberately absent: `light.fireSync` is 'conditional'
 * cadence (a continuous per-frame sim once lit, confirmed at its own
 * declaration), not 'bake' — it has no version-gated rebuild for a
 * mask-authority refresh to force, so watching it here would only ever read
 * zero and call that a result.
 *
 * MECHANISM: reuses `compareAbBlocks`/`aggregateAbCycles` — the exact same
 * ON→OFF→ON bracketing and noise-floor honesty `runStructuralAB` already
 * proved out — with a different idea of what "ON" means. There is no boolean
 * to flip here; "ON" is a window where `opts.triggerEdit()` fires
 * `opts.pings` times (each call is a full ping-then-unset cycle, so the
 * scoped flag this touches is never left set between edits, and a throw
 * partway through a burst leaves at most one edit unreverted for the caller's
 * own outer `finally` to catch); "OFF" is an equal-length window where nothing
 * touches any document at all. The two ON windows bracketing OFF measure this
 * run's own drift exactly like every other A/B in this file, for the same
 * reason: a delta smaller than that drift is not a result.
 *
 * DELIBERATELY DOES NOT KNOW WHAT A "TILE" IS. `opts.triggerEdit` is injected
 * — `boot.js` supplies the real `pickStressTestTile`/`pingStressTestTile`/
 * `unpingStressTestTile` (`src/foundry/scene-tiles.js`) call; this module stays
 * exactly as Foundry-agnostic and Node-testable as `runStructuralAB` already
 * is, with a fake `triggerEdit` standing in for the real document write.
 */

/** Full ping-then-unset cycles fired inside each burst ("ON") window. */
export const DEFAULT_EDIT_CASCADE_PINGS = 15;
/** Frames waited between one cycle's end and the next one starting — enough
 * for `redrawOn`'s fire-and-forget hook handler to actually run and for
 * whatever it triggers to land inside a profiled frame, not a wall-clock
 * delay (this module has no timer of its own — see this file's header on why
 * every wait already goes through the harness's own `waitFrames`). */
export const DEFAULT_EDIT_CASCADE_GAP_FRAMES = 6;

/**
 * Every 'bake'-cadence zone (`perf-zones.js`) reachable from a mask-authority
 * version bump — see this section's own header for the source-verified chain.
 * Not a filter (every zone in a block is still recorded); this is what the
 * result leads with.
 */
export const EDIT_CASCADE_WATCH_ZONES = Object.freeze([
  'tick.windRebakePoll',
  'sims.windBake',
  'light.sunShadowBake',
  'light.waterBodyBake',
  'light.waterFlowBake',
  'light.fluidNetBake',
  'surface.specularIslandBake',
]);

/**
 * Run the editing-cadence stress test live.
 *
 * @param {object} harness the same profile harness `runStructuralAB` uses
 * @param {object} opts
 * @param {() => Promise<void>} opts.triggerEdit fires ONE ping-then-unset
 *   cycle. Required — with no injected edit trigger there is nothing to
 *   burst, and this returns `skipped`, never a fabricated zero-cost result.
 * @param {number} [opts.pings]
 * @param {number} [opts.gapFrames]
 * @param {number} [opts.settleFrames]
 * @param {number} [opts.cycles] see `buildAbSequence`/`aggregateAbCycles`.
 * @param {Record<string, number>|null} [opts.routeZones] main-window per-frame
 *   zone GPU, for the same representativeness check `compareAbBlocks` already does.
 */
export async function runEditCascadeStress(harness, opts = {}) {
  const {
    triggerEdit,
    pings = DEFAULT_EDIT_CASCADE_PINGS,
    gapFrames = DEFAULT_EDIT_CASCADE_GAP_FRAMES,
    settleFrames = DEFAULT_AB_SETTLE_FRAMES,
    cycles = DEFAULT_AB_CYCLES,
    routeZones = null,
    onProgress = null,
  } = opts;

  const say = (phase, detail) => {
    if (typeof onProgress === 'function') onProgress(phase, detail);
  };

  if (typeof triggerEdit !== 'function') {
    return {
      ran: false,
      skipped: 'no-edit-trigger',
      note: 'No triggerEdit function was supplied, so no edit-cascade burst is possible. That is a wiring gap (or, at the boot.js call site, an honestly-reported "this scene has no tile to ping"), not a measurement result.',
      result: null,
    };
  }

  const windowFrames = pings * gapFrames;

  const measureBlock = async (withBurst, label) => {
    harness.resetFrameStats();
    harness.armProfiler({ settleFrames });
    try {
      await harness.waitFrames(settleFrames);
      const timer = harness.setGpuZoneTimer(true);
      try {
        if (withBurst) {
          for (let i = 0; i < pings; i++) {
            say('edit-cascade-stress', `${label} — edit ${i + 1}/${pings}`);
            await triggerEdit();
            await harness.waitFrames(gapFrames);
          }
        } else {
          say('edit-cascade-stress', `${label} — quiet, no edits`);
          await harness.waitFrames(windowFrames);
        }
        const block = summariseAbBlock({ profile: harness.readProfile(), gpuStatus: harness.getGpuZoneStatus() });
        block.gpuTimer = timer ?? null;
        return block;
      } finally {
        harness.setGpuZoneTimer(false);
      }
    } finally {
      harness.disarmProfiler();
    }
  };

  harness.hideLiveUi?.();
  const sequence = buildAbSequence(cycles);
  const blocksArray = [];
  try {
    for (let step = 0; step < sequence.length; step++) {
      const state = sequence[step];
      const withBurst = state === 'on';
      blocksArray.push(await measureBlock(withBurst, withBurst ? 'BURST' : 'QUIET'));
    }
  } finally {
    harness.restoreLiveUi?.();
  }

  const windows = [];
  for (let i = 0; i + 2 < blocksArray.length; i += 2) {
    windows.push({ on1: blocksArray[i], off: blocksArray[i + 1], on2: blocksArray[i + 2] });
  }
  const combined = aggregateAbCycles({ windows, watchZones: EDIT_CASCADE_WATCH_ZONES, routeZones });

  return {
    ran: true,
    skipped: null,
    method: `${sequence.join('→').replace(/on/g, 'burst').replace(/off/g, 'quiet')}, ${pings} edits/burst window (${gapFrames} frames apart), profiler armed per block${
      cycles > 1 ? ` (${cycles} cycles)` : ''
    }`,
    pings,
    gapFrames,
    cycles: windows.length,
    blocks: blocksArray,
    verdict: combined.verdict,
    burstGpuMs: combined.onGpuMs,
    quietGpuMs: combined.offGpuMs,
    deltaGpuMs: combined.deltaGpuMs,
    noiseFloorMs: combined.noiseFloorMs,
    significanceFactor: combined.significanceFactor,
    perZone: combined.perZone,
    representative: combined.representative,
    perCycle: combined.perCycle,
    note: combined.note,
  };
}
