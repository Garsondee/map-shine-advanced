/**
 * perf-shader-variant-ab.js — restart-based structural A/B for shader-graph
 * forks that (like albedo clarity's own) are JS-level branches read ONCE PER
 * MATERIAL BUILD, never a live uniform, so the ONLY lever that reaches an
 * already-compiled material is a full viewer restart. Same reasoning
 * `perf-sharpening-ab.js`'s own header already gives for CAS — this file
 * generalizes that SHAPE to more than one toggle, without editing that file:
 * it is proven and already live-run once, and reshaping a working path to
 * make a new one prettier is not this session's job.
 *
 * ============================================================================
 * THE TWO TOGGLES, AND WHAT EACH ONE'S "ON" LEG ACTUALLY MEANS
 * ============================================================================
 * Unlike CAS (where 'on' = the shipping, higher-fidelity path), both toggles
 * here have their 'on' leg mean "force the DIAGNOSTIC, non-default state":
 *
 * - `maskNode`: 'on' = the depth-authority discard (`material.maskNode`) is
 *   REMOVED from the compiled shader — every fragment survives to shading
 *   regardless of what a higher-ranked layer already covers.
 *   ⚠️ VISUALLY WRONG WHILE ARMED (same doc already on `debugForceMaskNodeOff`
 *   in vt-pan-viewer.js): overdraw a higher-ranked layer would normally
 *   reject now shows through. This measures TWO things at once, deliberately
 *   conflated because they are the same real question: what the discard's
 *   own sample+compare costs, AND how much overdraw it is currently
 *   preventing (the population of fragments that only stay hidden because
 *   this check exists). A large ON-vs-OFF delta means real overdraw is being
 *   caught; a small one means either little overdraw exists, or the discard
 *   itself is cheap regardless.
 * - `opaqueBlendOff`: 'on' = alpha blending is forced off
 *   (`material.transparent = false`) for tiles the engine has already
 *   certified fully opaque (`alwaysOpaque`) AND that are not excluded for a
 *   structural reason (`t.earlyZReason` — vegetation, a live occlusion fade,
 *   or authored alpha; see `debugForceOpaqueBlendOff`'s own comment in
 *   vt-pan-viewer.js for why those three specifically). This leg SHOULD be
 *   visually lossless where it engages at all — unlike maskNode, a bug here
 *   would show as wrong pixels, not merely an expected diagnostic artifact.
 *
 * @module diag/perf-shader-variant-ab
 */
import { summariseAbBlock, compareAbBlocks, AB_SEQUENCE, DEFAULT_AB_MEASURE_FRAMES } from './perf-structural-ab.js';

/** `geometry.worldDraw` is where both toggles' own effect would show —
 * everything else is a confound check, same posture as
 * `SHARPENING_WATCH_ZONES`. */
const WORLD_DRAW_WATCH_ZONES = Object.freeze(['geometry.worldDraw', 'geometry.depthDraw', 'geometry.earlyZPrepass']);

/** Water's own surface draw is inside `geometry.worldDraw` (the shared,
 * un-zoned world-scene pass — see `waterCaustics`'s own catalog entry
 * below), the SAME reason `WORLD_DRAW_WATCH_ZONES` exists for the other two
 * toggles; no water-specific zone exists to bracket instead. */
const WATER_WATCH_ZONES = WORLD_DRAW_WATCH_ZONES;

/**
 * THE CATALOG. Same spirit as `STRUCTURAL_TOGGLES`
 * (`perf-structural-ab.js`) — kept here, Node-testable, each toggle's own
 * QUESTION travels with it.
 */
export const SHADER_VARIANT_TOGGLES = Object.freeze([
  Object.freeze({
    id: 'maskNode',
    label: 'Depth-authority mask (material.maskNode discard)',
    question:
      'What does the querySceneDepth discard (the early-occlusion-reject check every fragment pays) cost, and how much overdraw is it currently preventing from reaching the shader at all?',
    watchZones: WORLD_DRAW_WATCH_ZONES,
  }),
  Object.freeze({
    id: 'opaqueBlendOff',
    label: 'Alpha-blend skip for fully-opaque tiles (debugForceOpaqueBlendOff)',
    question:
      'For tiles already certified fully opaque, does forcing transparent:false (a plain overwrite instead of a read-modify-write blend) save real GPU time over the default blended draw?',
    watchZones: WORLD_DRAW_WATCH_ZONES,
  }),
  // WATER CAUSTICS (2026-08-27) — author: "we need to set which parts of the
  // effect are in which performance tiers but in order to do that we need
  // data." Currently `caustics` is bundled into tier 4 ("shore") alongside
  // shore-foam filaments and wave shoaling (`WATER.tiers`, water.js) with no
  // separate cost-class of its own; this toggle isolates JUST the Worley-net
  // block's own marginal cost, everything else tier 4 adds held fixed
  // (`shoaling` is untouched — see `causticsGateForce`'s own doc,
  // water-render.js). ⚠️ 'on' here means "caustics FORCED ON" (the opposite
  // convention from `maskNode`/`opaqueBlendOff`, whose 'on' leg is the
  // non-default diagnostic state) — deliberately, because caustics' own
  // DEFAULT-for-quality-tier state IS forced-on already, and the honest
  // question is "does the shipping feature cost anything", not "does
  // removing it save anything" phrased backwards.
  Object.freeze({
    id: 'waterCaustics',
    label: 'Water tier 4 caustics (the Worley cell-edge net)',
    question:
      "What does tier 4's caustic net (2 Worley layers, the wave/growth domain warps, the junction-brightness test) cost geometry.worldDraw, with shoaling and shore foam held fixed? Answers whether caustics deserves its own cost class/tier rather than sharing tier 4's.",
    watchZones: WATER_WATCH_ZONES,
  }),
]);

/** @param {string} id @returns {object|null} */
export function shaderVariantToggleById(id) {
  return SHADER_VARIANT_TOGGLES.find((t) => t.id === id) ?? null;
}

/** Frames the CPU profiler discards after a restart, on top of the restart's
 * own settle (waitForSceneSettled + a fixed margin) — small on purpose,
 * belt-and-suspenders rather than load-bearing, same constant CAS's own file
 * uses. */
const POST_RESTART_PROFILER_SETTLE_FRAMES = 30;

/**
 * Run the shader-variant structural A/B live, for one or more catalog
 * toggles in sequence. Each toggle gets its OWN try/finally restore (a failed
 * restart on toggle 2 must not cost toggle 1's already-measured data, and
 * must not skip toggle 2's own restore either) — this is the one real
 * structural difference from `runSharpeningAB`, which only ever had one
 * toggle to protect.
 *
 * @param {object} harness - the SAME profile harness `perf-session.js` uses
 *   (`profileHarness` in boot.js) — needs `readForcedShaderVariant`,
 *   `restartViewerWithForcedShaderVariant`, `resetFrameStats`, `armProfiler`,
 *   `disarmProfiler`, `waitFrames`, `setGpuZoneTimer`, `readProfile`,
 *   `getGpuZoneStatus`. Optional: `hideLiveUi`/`restoreLiveUi`.
 * @param {object} [opts]
 * @param {string[]} [opts.toggleIds] - run only these catalog entries, in
 *   catalog order. Omitted/null runs every entry.
 * @param {number} [opts.measureFrames]
 * @param {Record<string, number>|null} [opts.routeZones]
 * @param {(phase: string, detail?: string) => void} [opts.onProgress]
 * @returns {Promise<object>}
 */
export async function runShaderVariantAB(harness, opts = {}) {
  const { toggleIds = null, measureFrames = DEFAULT_AB_MEASURE_FRAMES, routeZones = null, onProgress = null } = opts;

  const say = (phase, detail) => {
    if (typeof onProgress === 'function') onProgress(phase, detail);
  };

  if (
    typeof harness?.restartViewerWithForcedShaderVariant !== 'function' ||
    typeof harness?.readForcedShaderVariant !== 'function'
  ) {
    return {
      ran: false,
      skipped: 'harness-cannot-restart',
      note: 'This harness exposes no restartViewerWithForcedShaderVariant/readForcedShaderVariant hook, so no shader-variant A/B is possible. That is a wiring gap, not a measurement result.',
      toggles: [],
    };
  }

  const wanted = toggleIds ? SHADER_VARIANT_TOGGLES.filter((t) => toggleIds.includes(t.id)) : SHADER_VARIANT_TOGGLES;
  if (wanted.length === 0) {
    return {
      ran: false,
      skipped: 'no-matching-toggles',
      note: `toggleIds ${JSON.stringify(toggleIds)} matched nothing in the catalog.`,
      toggles: [],
    };
  }

  // Same "the live HUD will fight the profiler for ownership" reasoning as
  // runStructuralAB/runSharpeningAB — taken down ONCE for the whole batch,
  // not per toggle, matching runStructuralAB's own placement.
  harness.hideLiveUi?.();

  const toggleResults = [];
  let hardFailure = null;
  try {
    for (const toggle of wanted) {
      // Read-back BEFORE flipping anything, same discipline every other
      // forced-variant override in this codebase follows — never flip a
      // switch blind, with nothing to restore it to.
      const original = harness.readForcedShaderVariant(toggle.id);
      const blocks = {};
      let toggleFailure = null;
      try {
        for (let step = 0; step < AB_SEQUENCE.length && !toggleFailure; step++) {
          const state = AB_SEQUENCE[step]; // 'on' | 'off' | 'on'
          const forceOn = state === 'on';
          say(
            'shader-variant-ab',
            `${toggle.label} — ${state.toUpperCase()} (${step + 1}/${AB_SEQUENCE.length}, restarting the viewer)`
          );

          const restartResult = await harness.restartViewerWithForcedShaderVariant(toggle.id, forceOn);
          if (restartResult?.ok === false) {
            toggleFailure = `viewer restart failed while forcing ${toggle.id}=${state}: ${restartResult.error ?? 'unknown error'}`;
            break;
          }

          say(
            'shader-variant-ab',
            `${toggle.label} ${state.toUpperCase()} — settling ${POST_RESTART_PROFILER_SETTLE_FRAMES} frames before measuring`
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
        // RESTORE THIS TOGGLE, ALWAYS — a 4th, unmeasured restart, same
        // "a failed restore is worse than a failed measurement" doctrine
        // perf-sharpening-ab.js's own comment states, checked BOTH ways a
        // restart can fail (a resolved {ok:false} and a thrown/rejected
        // promise).
        say('shader-variant-ab', `${toggle.label} — restoring the state this run found (one more restart)…`);
        try {
          const restoreResult = await harness.restartViewerWithForcedShaderVariant(toggle.id, original);
          if (restoreResult?.ok === false) {
            toggleFailure =
              toggleFailure ?? `restore-to-original-state failed: ${restoreResult.error ?? 'unknown error'}`;
          }
        } catch (err) {
          toggleFailure = toggleFailure ?? `restore-to-original-state threw: ${err?.message ?? err}`;
        }
      }

      if (toggleFailure) {
        toggleResults.push({
          id: toggle.id,
          label: toggle.label,
          question: toggle.question,
          ran: false,
          skipped: 'failed',
          note: toggleFailure,
        });
        continue;
      }

      toggleResults.push({
        id: toggle.id,
        label: toggle.label,
        question: toggle.question,
        liveState: original,
        measureFrames,
        blocks,
        ...compareAbBlocks({ ...blocks, watchZones: [...toggle.watchZones], routeZones }),
      });
    }
  } catch (err) {
    // Should be unreachable (every real failure path above is caught and
    // recorded per-toggle) — kept as a last-resort net so a genuinely
    // unexpected throw still restores the UI in the finally below, rather
    // than leaving the debug panel hidden with no way to tell why.
    hardFailure = `shader-variant A/B threw outside its own per-toggle handling: ${err?.message ?? err}`;
  } finally {
    harness.restoreLiveUi?.();
  }

  if (hardFailure) {
    return { ran: false, skipped: 'threw', note: hardFailure, toggles: toggleResults };
  }

  return {
    ran: true,
    skipped: null,
    method: `${AB_SEQUENCE.join('→')}, ${measureFrames} measured frames per block, viewer RESTARTED between each block (material-build-time shader fork, not a live toggle — same reasoning as perf-sharpening-ab.js's own header). Each toggle run independently, own restore.`,
    cameraNote:
      'Measured on whichever floor/view was active when this phase started, held fixed by each restart (camera position survives a restart for free). A GM nudging the camera mid-measurement would still break the "same view" assumption, the same pre-existing risk runStructuralAB/runSharpeningAB carry for their own parked window.',
    toggles: toggleResults,
  };
}
