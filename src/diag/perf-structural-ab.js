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
 * @module diag/perf-structural-ab
 */

/** ON → OFF → ON. The two ON blocks bracket OFF so their drift measures the run. */
export const AB_SEQUENCE = Object.freeze(['on', 'off', 'on']);

/** Frames discarded after a toggle flips, before measurement starts. */
export const DEFAULT_AB_SETTLE_FRAMES = 60;
/** Frames measured per state. */
export const DEFAULT_AB_MEASURE_FRAMES = 180;
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
]);

/** @param {string} id @returns {object|null} */
export function toggleById(id) {
  return STRUCTURAL_TOGGLES.find((t) => t.id === id) ?? null;
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
 * Run the A/B live. Sequential and slow by nature — each block needs its own
 * settle and its own armed window — but bounded and announced.
 *
 * @param {object} harness the same profile harness `perf-session.js` uses
 * @param {object} [opts]
 * @param {string[]} [opts.toggleIds] which toggles to run; defaults to every one
 *   the harness reports it can actually flip
 * @param {Record<string, number>|null} [opts.routeZones] main-window per-frame
 *   zone GPU, for the representativeness check
 */
export async function runStructuralAB(harness, opts = {}) {
  const { toggleIds = null, routeZones = null, measureFrames = DEFAULT_AB_MEASURE_FRAMES, onProgress = null } = opts;

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

  const results = [];
  try {
    for (const toggle of wanted) {
      const original = harness.readStructuralToggle(toggle.id);
      const settleFrames = toggle.settleFrames ?? DEFAULT_AB_SETTLE_FRAMES;
      const blocks = {};
      try {
        for (let step = 0; step < AB_SEQUENCE.length; step++) {
          const state = AB_SEQUENCE[step];
          const on = state === 'on';
          say('structural-ab', `${toggle.label} — ${state.toUpperCase()} (${step + 1}/${AB_SEQUENCE.length})`);
          harness.setStructuralToggle(toggle.id, on);
          await harness.waitFrames(settleFrames);

          harness.resetFrameStats();
          harness.armProfiler({ settleFrames: 0 });
          // Kept, not discarded: `{skipped: true, reason}` here is why a block
          // came back with no GPU numbers, and losing it turns a diagnosable
          // wiring problem into an unexplained null three layers up.
          const timer = harness.setGpuZoneTimer(true);
          try {
            await harness.waitFrames(measureFrames);
            const block = summariseAbBlock({
              profile: harness.readProfile(),
              gpuStatus: harness.getGpuZoneStatus(),
            });
            block.gpuTimer = timer ?? null;
            // ON is measured twice; keep both, keyed so compareAbBlocks can use
            // their disagreement as the floor.
            blocks[step === 0 ? 'on1' : step === 1 ? 'off' : 'on2'] = block;
          } finally {
            harness.setGpuZoneTimer(false);
            harness.disarmProfiler();
          }
        }
      } finally {
        // RULE 3. Non-negotiable, and outside the measurement try so it runs even
        // if arming itself threw.
        harness.setStructuralToggle(toggle.id, original);
      }

      results.push({
        id: toggle.id,
        label: toggle.label,
        question: toggle.question,
        liveState: original,
        settleFrames,
        measureFrames,
        blocks,
        ...compareAbBlocks({ ...blocks, watchZones: toggle.watchZones, routeZones }),
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
    method: `${AB_SEQUENCE.join('→')}, ${measureFrames} measured frames per block, profiler armed per block`,
    cameraNote:
      "Measured with the camera PARKED at wherever the benchmark route ended, not moving along it. That removes camera motion — the largest source of frame-to-frame variance, and most of why this resolves what the whole-frame effect sweep cannot — at the cost of measuring one view rather than the map. See each toggle's `representative` block for whether that view stood in for the route.",
    toggles: results,
  };
}
