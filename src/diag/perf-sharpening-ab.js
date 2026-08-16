/**
 * perf-sharpening-ab.js — DOES ALBEDO CLARITY'S CAS SHARPEN COST WHAT WE THINK?
 *
 * ============================================================================
 * WHY THIS IS ITS OWN FILE, AND NOT A RIDER ON perf-structural-ab.js
 * ============================================================================
 * `shouldUseFullAlbedoClarity()` (vt-pan-viewer.js) is a JS-level branch read
 * ONCE PER MATERIAL BUILD — a real shader-graph fork (the full 5-tap CAS node
 * vs. a flat 1-tap read), not a live uniform. `perf-structural-ab.js`'s own
 * `runStructuralAB` settles a toggle by flipping it and waiting N frames,
 * which is the right model for `earlyZComposition` (a live pipeline choice)
 * and the WRONG model here: no amount of frame-waiting rebuilds an
 * already-compiled material (vt-pan-viewer.js's own doc on this exact point —
 * "a live profile toggle mid-session is not expected to retroactively cheapen
 * an already-compiled material"). The only lever that reaches an
 * already-built material is a full viewer restart
 * (`stopVtPanViewer`/`startVtPanViewer` — confirmed by grepping every
 * `registerAction` in boot.js for a lighter alternative; there isn't one).
 *
 * `perf-structural-ab.js` is itself "sensitive, well-tested measurement code"
 * (docs/holy/V4-Testament.md) — this file reuses its PURE, already-exported
 * math (`summariseAbBlock`, `compareAbBlocks`, `AB_SEQUENCE`) without editing
 * a line of its orchestration loop, so `earlyZComposition`'s own working
 * measurement stays untouched regardless of what happens here.
 *
 * ============================================================================
 * THE COST OF THIS METHOD, NAMED PLAINLY
 * ============================================================================
 * Four full viewer restarts (ON→OFF→ON to measure, plus a 4th to restore the
 * state this run found) — each pays a real `renderer.compileAsync` and
 * reconstructs every subsystem (occlusion mask, scene depth, water body, sun
 * shadows, specular, window light, point-light pool, door graphics). Unlike
 * `earlyZComposition`'s toggle, this has NEVER been measured live before —
 * the first real `perf-run-full` capture that runs this phase IS the timing
 * experiment that decides whether it's cheap enough to default on (see
 * `boot.js`'s own `MapShine.setSharpeningAbEnabled` — gated OFF by default
 * for exactly this reason).
 *
 * @module diag/perf-sharpening-ab
 */
import { summariseAbBlock, compareAbBlocks, AB_SEQUENCE, DEFAULT_AB_MEASURE_FRAMES } from './perf-structural-ab.js';

/** Frames the CPU profiler discards before measuring, ON TOP OF the restart's
 * own extensive settle (waitForSceneSettled + a 15s fixed margin) — small on
 * purpose, belt-and-suspenders rather than load-bearing. */
const POST_RESTART_PROFILER_SETTLE_FRAMES = 30;

/** `geometry.worldDraw` is where the CAS taps actually live
 * (`buildWholeImageMaterial`'s `colorNode`) — the one zone this measurement
 * exists to resolve. The depth-only passes use a different material entirely
 * (`buildSceneDepthWriterMaterial`) and are watched too, purely as a confound
 * check: they should show ~0 delta, which is what proves the measurement is
 * isolating the right thing rather than some other restart side effect. */
export const SHARPENING_WATCH_ZONES = Object.freeze([
  'geometry.worldDraw',
  'geometry.depthDraw',
  'geometry.earlyZPrepass',
]);

/**
 * Run the Albedo Clarity structural A/B live. Sequential, slow (four real
 * viewer restarts), bounded and announced — same honesty posture as
 * `runStructuralAB`, adapted for a settle model that is "restart and wait for
 * real readiness" rather than "flip and wait N frames".
 *
 * @param {object} harness the SAME profile harness object perf-session.js
 *   uses (`profileHarness` in boot.js) — needs `readAlbedoClarityForce`,
 *   `restartViewerWithAlbedoClarityForce`, `resetFrameStats`, `armProfiler`,
 *   `disarmProfiler`, `waitFrames`, `setGpuZoneTimer`, `readProfile`,
 *   `getGpuZoneStatus`.
 * @param {object} [opts]
 * @param {number} [opts.measureFrames]
 * @param {Record<string, number>|null} [opts.routeZones] main-window per-frame
 *   zone GPU, for the representativeness check `compareAbBlocks` already
 *   knows how to run. Left `null` unless a caller supplies one — by the time
 *   this phase runs (after every `runProfileSession` camera sweep has already
 *   finished), the natural route window's own camera has moved on, so there
 *   is no reason to trust it as "the same view" without being told otherwise.
 * @param {(phase: string, detail?: string) => void} [opts.onProgress]
 * @returns {Promise<object>}
 */
export async function runSharpeningAB(harness, opts = {}) {
  const { measureFrames = DEFAULT_AB_MEASURE_FRAMES, routeZones = null, onProgress = null } = opts;

  const say = (phase, detail) => {
    if (typeof onProgress === 'function') onProgress(phase, detail);
  };

  if (
    typeof harness?.restartViewerWithAlbedoClarityForce !== 'function' ||
    typeof harness?.readAlbedoClarityForce !== 'function'
  ) {
    return {
      ran: false,
      skipped: 'harness-cannot-restart',
      note: 'This harness exposes no restartViewerWithAlbedoClarityForce/readAlbedoClarityForce hook, so no sharpening A/B is possible. That is a wiring gap, not a measurement result.',
      toggles: [],
    };
  }

  // Read-back BEFORE flipping anything, same discipline
  // perf-structural-ab.js's own STRUCTURAL_TOGGLES filter uses — never flip a
  // switch blind, with nothing to restore it to.
  const original = harness.readAlbedoClarityForce();

  // THE LIVE HUD WILL FIGHT THIS FOR THE PROFILER IF IT IS VISIBLE — the
  // exact reason `runStructuralAB` owns this same pair itself rather than
  // trusting an outer caller to have hidden it already: by the time Phase 4
  // runs, Phase 1/2/3's own hide/restore calls have already put the panel
  // back, so it is visible again here unless THIS function takes it down.
  // The perf HUD re-arms the profiler as owner 'hud' ~4x/second, and
  // `frame-profiler.arm()` throws on an owner mismatch.
  harness.hideLiveUi?.();

  const blocks = {};
  let failure = null;
  try {
    for (let step = 0; step < AB_SEQUENCE.length && !failure; step++) {
      const state = AB_SEQUENCE[step]; // 'on' | 'off' | 'on'
      const forceFullCas = state === 'on'; // 'on' = force the full 5-tap CAS graph, 'off' = force the flat 1-tap
      say(
        'sharpening-ab',
        `Albedo Clarity — ${state.toUpperCase()} (${step + 1}/${AB_SEQUENCE.length}, restarting the viewer)`
      );

      const restartResult = await harness.restartViewerWithAlbedoClarityForce(forceFullCas);
      if (restartResult?.ok === false) {
        failure = `viewer restart failed while forcing ${state}: ${restartResult.error ?? 'unknown error'}`;
        break;
      }

      // ARM ONLY AFTER THE RESTART HAS ALREADY PROVEN THE VIEWER IS ALIVE —
      // never speculatively at t=0. `restartViewerWithAlbedoClarityForce`'s
      // own promise does not resolve until `startVtPanViewer` has awaited a
      // real `renderer.compileAsync` AND `waitForSceneSettled` has reported
      // real readiness, so by this line `_active` is guaranteed constructed
      // and rendering — the exact proof-of-life this codebase's own
      // one-shot-arm-races-a-lazy-singleton incident (perf-session.js's GPU
      // zone timer, fixed 2026-08-11) says an arm call must wait for.
      say(
        'sharpening-ab',
        `${state.toUpperCase()} — settling ${POST_RESTART_PROFILER_SETTLE_FRAMES} frames before measuring`
      );
      harness.resetFrameStats();
      harness.armProfiler({ settleFrames: POST_RESTART_PROFILER_SETTLE_FRAMES });
      try {
        await harness.waitFrames(POST_RESTART_PROFILER_SETTLE_FRAMES);
        const timer = harness.setGpuZoneTimer(true);
        try {
          await harness.waitFrames(measureFrames);
          const block = summariseAbBlock({ profile: harness.readProfile(), gpuStatus: harness.getGpuZoneStatus() });
          block.gpuTimer = timer ?? null;
          blocks[step === 0 ? 'on1' : step === 1 ? 'off' : 'on2'] = block;
        } finally {
          harness.setGpuZoneTimer(false);
        }
      } finally {
        harness.disarmProfiler();
      }
    }
  } finally {
    // RESTORE, ALWAYS — a 4th, unmeasured restart, because clearing the
    // override alone does not touch already-built materials. Outside the
    // measurement try/catch so it runs even if a step above threw. Matches
    // this codebase's own explicit doctrine elsewhere in boot.js: a
    // performance report must never leave the scene somewhere other than
    // where it found it, on any exit path.
    say('sharpening-ab', 'restoring the state this run found (one more restart)…');
    try {
      // A failed RESTORE is worse than a failed measurement — it can leave a
      // real session running the wrong shader variant with nothing pointing
      // back here. Reported, never swallowed silently — checked BOTH ways a
      // restart can fail: a resolved `{ok:false}` (restartViewerWith
      // AlbedoClarityForce's own normal failure shape, e.g. "could not read
      // this scene's floors") and a genuine thrown/rejected promise. Caught
      // live by this file's own test: a fake harness modelling the resolved-
      // failure shape sailed straight through a `.catch()`-only version of
      // this block.
      const restoreResult = await harness.restartViewerWithAlbedoClarityForce(original);
      if (restoreResult?.ok === false) {
        failure = failure ?? `restore-to-original-state failed: ${restoreResult.error ?? 'unknown error'}`;
      }
    } catch (err) {
      failure = failure ?? `restore-to-original-state threw: ${err?.message ?? err}`;
    }
    // Paired with hideLiveUi above, and unconditional: a throw partway
    // through must not leave the debug panel gone with no way to tell why.
    harness.restoreLiveUi?.();
  }

  if (failure) {
    // 'failed', not 'threw' — every failure path above is a checked
    // `{ok:false}` result, not an uncaught exception; the wording should not
    // claim more drama than actually happened.
    return { ran: false, skipped: 'failed', note: failure, toggles: [] };
  }

  return {
    ran: true,
    skipped: null,
    method: `${AB_SEQUENCE.join('→')}, ${measureFrames} measured frames per block, viewer RESTARTED between each block (material-build-time shader fork, not a live toggle — perf-structural-ab.js's generic settle-by-waiting model does not apply here)`,
    cameraNote:
      'Measured on whichever floor/view was active when this phase started, held fixed by the restart (camera position survives a restart for free — see restartViewerWithAlbedoClarityForce\'s own doc). A GM nudging the camera mid-measurement would still break the "same view" assumption, the same pre-existing risk runStructuralAB carries for its own parked window.',
    toggles: [
      {
        id: 'albedoClarity',
        label: "Albedo Clarity (CAS sharpen, 5 of buildWholeImageMaterial's 6 texture taps)",
        question:
          'Does the full 5-tap CAS graph cost real, measurable GPU time over the flat 1-tap read the performance/low profile tiers already use?',
        liveState: original,
        measureFrames,
        blocks,
        ...compareAbBlocks({ ...blocks, watchZones: [...SHARPENING_WATCH_ZONES], routeZones }),
      },
    ],
  };
}
