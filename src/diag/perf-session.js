/**
 * perf-session.js — THE ONE BUTTON. Orchestrates a measurement run and hands
 * back a finished report.
 *
 * Pure orchestration over an injected `harness`, so the whole sequence — the
 * mutual-exclusion guard, the settle window, the always-disarm — is Node-tested
 * against a fake harness with no browser, exactly like `perf-lab.js`'s sweep.
 *
 * ============================================================================
 * WHY THIS IS NOT IN perf-lab.js
 * ============================================================================
 *
 * `perf-lab.js` owns the effect on/off SWEEP, which is a different measurement
 * with its own hard-won post-mortem baked into its header (it once reported
 * "41.90 ms GPU" beside "8.40 ms felt" by measuring pipeline queue depth). This
 * file owns per-zone attribution. They answer different questions and fail in
 * different ways; folding them together would put one instrument's correction
 * history in the way of the other's. The sweep is CONSUMED here as an optional
 * cross-check, not absorbed.
 *
 * ============================================================================
 * THE ONE THING THAT MUST NEVER HAPPEN
 * ============================================================================
 *
 * The GPU probe (`diag/gpu-probe.js`) THROTTLES the render loop while measuring
 * — `renderFrame` early-returns entirely on `gpuProbe.isMeasuring()`. Frames
 * skipped that way never open a zone, so a profile taken while the probe is
 * armed would silently drop most of its samples and every occurrence rate would
 * be wrong by an unknown factor. That is a hard error here, not a comment.
 *
 * ============================================================================
 * THE GPU ZONE TIMER ARMS AFTER SETTLING, NOT BEFORE (2026-08-11)
 * ============================================================================
 *
 * `setGpuZoneTimer` routes through the vt-pan-viewer instance, reachable only
 * via a module-level `_active` that is not set until `startVtPanViewer`
 * finishes construction. Arming at t=0 raced that construction: on a slow
 * scene (the 12k mansion's upper floor is the known-worst case) `_active` was
 * still null, the arm call silently no-op'd with `{skipped:true,
 * reason:'viewer not started'}`, and every `zones[].gpuMs` came back null for
 * the rest of the run — three separate live captures reproduced this exact
 * signature (`instrument.gpuTimer.armResult` in the saved reports), and
 * nothing retried the arm. `method.gpu` still read `'timestamp-query'`
 * throughout, because that field was built from `gpuStatus.capable` — a
 * static per-device probe, true regardless of whether arming happened — so
 * the report never told the reader the arm had been skipped (Moonshot.md §7's
 * flagged gap). The fix has two parts: arm only after `waitFrames(settleFrames)`
 * proves frames are actually flowing (a live render loop is the only thing
 * that advances the profiler's frame count, so `_active` is guaranteed by
 * then), and build `method.gpu`/`gpuReason` from the arm RESULT as well as
 * static capability, so a future skip — for any reason — is reported honestly
 * instead of silently.
 *
 * @module diag/perf-session
 */
import { buildPerfReport } from './perf-report.js';
import { EFFECT_ZONING, FRAME_BUDGET_MS, ZONES } from './perf-zones.js';
import { DEFAULT_SETTLE_FRAMES } from './frame-profiler.js';
import { runStructuralAB } from './perf-structural-ab.js';

/** Default measured window. ~10s at 60fps — long enough for a bake to appear. */
export const DEFAULT_MEASURE_FRAMES = 600;
/** A window that has not advanced in this long means the viewer is not running. */
export const WAIT_TIMEOUT_MS = 30000;

/**
 * Build the `waitFrames` half of a harness.
 *
 * Waits for frames the profiler ACTUALLY COUNTED, not for `n` rAF ticks. They
 * are different things: the viewer's loop can be stopped, backgrounded, or
 * skipping frames, and a tick-counting wait would then hand back a window with
 * far fewer frames in it than the report goes on to claim. Bounded, so a stopped
 * viewer fails loudly instead of hanging the button forever.
 *
 * Lives here rather than in `boot.js` because it reads a clock, and
 * `time/one-clock` allows that in `diag/` and nowhere near the composition root.
 */
export function createProfiledFrameWaiter({
  readProfile,
  raf = (cb) => requestAnimationFrame(cb),
  now = () => performance.now(),
  timeoutMs = WAIT_TIMEOUT_MS,
} = {}) {
  return function waitFrames(n) {
    return new Promise((resolve, reject) => {
      const before = readProfile();
      const startCount = before.frames + before.settleFramesDiscarded;
      const startedAt = now();
      const tick = () => {
        const s = readProfile();
        const seen = s.frames + s.settleFramesDiscarded - startCount;
        if (seen >= n) {
          resolve();
          return;
        }
        if (now() - startedAt > timeoutMs) {
          reject(
            new Error(
              `perf profile: waited ${Math.round(timeoutMs / 1000)}s for ${n} frames but only ${seen} were ` +
                'counted. The viewer is probably not running — load a scene first.'
            )
          );
          return;
        }
        raf(tick);
      };
      raf(tick);
    });
  };
}

/**
 * @typedef {object} ProfileHarness
 * @property {() => boolean} isGpuProbeArmed
 * @property {(opts: object) => void} armProfiler
 * @property {() => void} disarmProfiler
 * @property {() => object} readProfile          frame-profiler snapshot()
 * @property {(on: boolean) => object} setGpuZoneTimer
 * @property {() => object} getGpuZoneStatus
 * @property {() => void} resetFrameStats
 * @property {() => object} readFrameStats       {gapSamples, hitches, gpuMs, ...}
 * @property {() => object} getContext           {resolution, sceneName, floorIndex, enabledEffects}
 * @property {(n: number) => Promise<void>} waitFrames
 * @property {() => object[]} getManifests
 * @property {() => object|null} readVram
 * @property {(() => Promise<object>)} [runSweep]
 */

/**
 * Run one profile and return the finished report.
 *
 * @param {ProfileHarness} harness
 * @param {object} [opts]
 */
export async function runProfileSession(harness, opts = {}) {
  const {
    settleFrames = DEFAULT_SETTLE_FRAMES,
    measureFrames = DEFAULT_MEASURE_FRAMES,
    includeSweep = false,
    // DEFAULT ON, unlike includeSweep (2026-08-12). It is cheap relative to what
    // it answers — three short parked blocks against the sweep's 18 configs —
    // and every capture to date has left the question it settles open.
    includeStructuralAB = true,
    verbosity = 'default',
    route = null,
    /** A promise that resolves when the workload ends; replaces `measureFrames`. */
    measureUntil = null,
    onProgress = null,
    generatedAt = null,
    // How often the measuring phase ticks progress, see below. Overridable so
    // a test can see a tick without a real second-long wait.
    measuringTickIntervalMs = 1000,
  } = opts;

  // See this file's header. Refusing loudly beats producing a report whose every
  // occurrence rate is wrong by a factor nobody can recover.
  if (harness.isGpuProbeArmed()) {
    throw new Error(
      'runProfileSession: the whole-frame GPU probe is armed. It throttles the render loop (renderFrame ' +
        'early-returns while it measures), so frames would be skipped without opening any zone and every ' +
        'occurrence rate in the resulting report would be silently wrong. Finish or cancel the sweep first.'
    );
  }

  // THE HUD OWNS THE PROFILER WHILE IT IS VISIBLE, and re-arms it every 250ms to
  // keep a rolling window — which resets the very frame counters this session
  // waits on. Live, 2026-07-27, that presented as "waited 30s for 30 frames but
  // only 4 were counted" on a viewer rendering perfectly well. The symptom
  // pointed at the renderer; the cause was two instruments sharing one.
  const busyOwner = harness.profilerOwner?.() ?? null;
  if (busyOwner && busyOwner !== 'session') {
    throw new Error(
      `runProfileSession: the profiler is already owned by '${busyOwner}'` +
        (busyOwner === 'hud'
          ? ' — the live zone HUD is on. It re-arms the profiler four times a second for its rolling window, ' +
            "which would reset this run's frame counter mid-window. Toggle the HUD off and run again."
          : '. Stop it before profiling.')
    );
  }

  const say = (phase, detail) => {
    if (typeof onProgress === 'function') onProgress(phase, detail);
  };

  let gpuTimer = null;
  let armed = false;
  // Declared here, not inside the try block below: a `const` scoped to that
  // block would not survive past its own closing brace, and this value is
  // needed again after `finally` runs, when the report gets assembled.
  let pipelineStatsStart = null;
  // DEPTH-PROXY MATERIAL POOL HEALTH (DEFERRED-S1b, 2026-08-11) — same
  // before/after-the-window shape as pipelineStats immediately above, and
  // for the same reason: `depthProxyMaterialPool.stats()` is a LIFETIME
  // counter, so only the DELTA across this window says anything about what
  // happened during it. Optional exactly like readPipelineStats — a harness
  // that does not implement it (this file's own fake-harness tests) yields
  // `null`, and `buildPerfReport` must treat a null pair as "not measured",
  // never as "the pool did nothing".
  let depthProxyPoolStatsStart = null;
  try {
    harness.resetFrameStats();
    harness.armProfiler({ settleFrames });
    armed = true;

    // HIDE-WHILE-MEASURING (Testament Stage 4, 2026-08-11) — before settling
    // even starts, so the settle window ALSO runs with the UI hidden, not
    // just the measured portion. `restoreLiveUi` (finally, below) always
    // runs, reopening the panel only if it was open before this call — see
    // boot.js's own `debugPanelVisibleBeforeHide` for that half.
    harness.hideLiveUi?.();

    say('settling', `${settleFrames} frames discarded (shader compile, first residency pass, first bake)`);
    await harness.waitFrames(settleFrames);

    // ARMED HERE, AFTER SETTLING, NOT BEFORE (2026-08-11) — `setGpuZoneTimer`
    // routes through the vt-pan-viewer instance (`diag/gpu-zone-timer.js`
    // needs the live `renderer`), which callers reach through a module-level
    // `_active` set only once `startVtPanViewer` finishes construction. Arming
    // at t=0, before that construction is guaranteed done, raced it: on a slow
    // scene (the 12k mansion's upper floor is the known-worst case) `_active`
    // was still null, `setGpuZoneTimer(true)` silently no-op'd with
    // `{skipped:true, reason:'viewer not started'}`, and every zone's gpuMs
    // came back null for the rest of the run — nothing here ever retried it.
    // Three separate live captures reproduced exactly this signature (see
    // `instrument.gpuTimer.armResult` in the saved reports). `method.gpu`
    // still read 'timestamp-query' throughout, because that field reflects
    // static device CAPABILITY (`gpuStatus.capable`, probed once at
    // construction), not whether arming actually happened this run — the
    // report was never wrong about the hardware, only silent about the skip.
    // The settle wait above is proof of life: `waitFrames` only resolves once
    // the profiler has actually COUNTED frames, and only a live viewer's
    // render loop calls `profiler.endFrame()` — so `_active` is guaranteed
    // non-null by the time we get here. This also stops wasting query-pool
    // slots on settle-window passes, which folded as unattributed anyway
    // (CPU zones stay closed while `settleRemaining > 0`, frame-profiler.js).
    say('arming', 'starting the GPU zone timer');
    gpuTimer = harness.setGpuZoneTimer(true);
    // SHADER-REBUILD CHURN (2026-08-11) — armed for every measured window from
    // here on, not just when someone remembers to run it by hand from the
    // console. See shader-rebuild-probe.js's own header for the mechanism this
    // watches: a pool/cache whose hit rate silently collapses produces CORRECT
    // pixels and WRONG performance, so nothing but this kind of instrument
    // would ever notice — the vegetation depth-proxy bug this exists to catch
    // was found only by hours of Chrome-trace reading, precisely because
    // nothing was watching loudly enough. Optional on the harness (like
    // readPipelineStats above it): a caller without it just measures without
    // this instrument.
    if (typeof harness.setShaderRebuildProbe === 'function') harness.setShaderRebuildProbe(true);

    // PIPELINE HEALTH, START OF THE REAL WINDOW (2026-08-09) — sampled here,
    // not before settling, on purpose: settle frames exist BECAUSE first-use
    // shader compiles are expected and normal (this function's own settle
    // rationale, one line up). Sampling before settling would count that
    // expected one-time cost as part of the "did anything change during
    // STEADY panning" delta this exists to answer. Optional: a harness that
    // does not implement it (the fake one in this file's own tests) yields
    // `null` here, and `buildPerfReport` treats a null pair as "not measured
    // this run", never as "zero pipelines".
    pipelineStatsStart = typeof harness.readPipelineStats === 'function' ? harness.readPipelineStats() : null;
    depthProxyPoolStatsStart =
      typeof harness.readDepthProxyPoolStats === 'function' ? harness.readDepthProxyPoolStats() : null;

    // PERIODIC PROGRESS DURING THE MEASURING WINDOW (2026-08-11, author: "even
    // without a UI it would be nice to have text on screen to give me a rough
    // idea of how far through the process I am") — `hideLiveUi` above can take
    // the debug panel away for the full length of a `perf-run-full` route
    // (minutes, not seconds), and the `say('measuring', …)` calls below fire
    // exactly ONCE each, at the start of their branch. Without a tick there is
    // nothing to report for the entire span between "measuring" and
    // "building". A plain interval, not another rAF hook: this only needs to
    // update text a couple of times a second, and `readProfile()` is already
    // a cheap, allocation-light snapshot meant to be polled from outside the
    // render loop — `createProfiledFrameWaiter` above calls it on every rAF
    // tick for the whole wait. Created only when someone is listening, so a
    // caller with no `onProgress` (every non-interactive/test caller) pays
    // nothing extra — no timer, no extra `readProfile()` calls.
    const tickMeasuringProgress = () => {
      const p = harness.readProfile();
      const elapsedS = (p.durationMs / 1000).toFixed(1);
      say('measuring-tick', `${p.frames} frames · ${elapsedS}s elapsed`);
    };
    const progressTimer =
      typeof onProgress === 'function' ? setInterval(tickMeasuringProgress, measuringTickIntervalMs) : null;
    try {
      if (measureUntil) {
        // ROUTE-DRIVEN: measure for exactly as long as the workload runs, not for
        // a frame count guessed from an unknown frame rate. A 60s sweep at an
        // unknown 30–60fps is 1,800–3,600 frames; picking either number would
        // truncate the route or sit idle at the end of it.
        say('measuring', 'until the benchmark route completes');
        await measureUntil;
      } else {
        say('measuring', `${measureFrames} frames`);
        await harness.waitFrames(measureFrames);
      }
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
  } finally {
    // ALWAYS, on every path. The GPU timer holds a vendor-internal flag on and a
    // query pool that three never prunes; leaving either armed after a thrown
    // error would leak for the rest of the session.
    if (armed) harness.disarmProfiler();
    try {
      harness.setGpuZoneTimer(false);
    } catch {
      // Reported below via gpuStatus rather than swallowed — but a failure to
      // disarm must not mask the original error on the throwing path.
      say('warning', 'failed to disarm the GPU zone timer');
    }
    try {
      if (typeof harness.setShaderRebuildProbe === 'function') harness.setShaderRebuildProbe(false);
    } catch {
      say('warning', 'failed to disarm the shader-rebuild probe');
    }
    // ALWAYS, same reasoning as disarmProfiler above — a thrown error must
    // still hand the panel back, or a failed run leaves the author with no
    // UI and no idea why.
    try {
      harness.restoreLiveUi?.();
    } catch {
      say('warning', 'failed to restore the debug panel after measuring');
    }
  }

  const profile = harness.readProfile();
  const frameStats = harness.readFrameStats();
  const context = harness.getContext();
  const gpuStatus = harness.getGpuZoneStatus();
  // PIPELINE HEALTH, END OF THE REAL WINDOW — paired with pipelineStatsStart
  // above. Read here, before the sweep (which deliberately toggles effects
  // on/off and would build/dispose materials of its own, poisoning "did
  // anything change during ordinary panning" with the sweep's OWN expected
  // churn).
  const pipelineStatsEnd = typeof harness.readPipelineStats === 'function' ? harness.readPipelineStats() : null;
  // Same "before the sweep" reasoning as pipelineStatsEnd: the sweep
  // deliberately disposes/rebuilds effect materials of its own, which would
  // register as pool churn that has nothing to do with ordinary panning.
  const depthProxyPoolStatsEnd =
    typeof harness.readDepthProxyPoolStats === 'function' ? harness.readDepthProxyPoolStats() : null;
  // SHADER-REBUILD CHURN, read AFTER disarm — same ordering as gpuStatus above
  // and for the same reason: disarm() uninstalls the hook but does not clear
  // the counters (only the NEXT arm's reset() does), so the just-finished
  // window's totals are still sitting there to read. No start/end pairing
  // needed here unlike pipelineStats/depthProxyPoolStats: the probe resets
  // itself to zero on every arm, so this single read already IS the delta for
  // this window, not a lifetime counter.
  const shaderRebuildStats =
    typeof harness.readShaderRebuildStats === 'function' ? harness.readShaderRebuildStats() : null;

  let sweep = null;
  if (includeSweep && typeof harness.runSweep === 'function') {
    say('sweeping', 'per-effect on/off marginal cost, as an independent cross-check');
    sweep = await harness.runSweep();
  }

  // STRUCTURAL A/B (2026-08-12) — "does this pipeline choice pay for itself",
  // which the effect sweep structurally cannot answer and which was previously
  // only reachable by running the whole capture twice by hand from Playwright
  // (tests/playwright-artifacts/look/stage1-earlyz-bench.mjs). Runs AFTER the
  // route and after the sweep, on a parked camera, and re-arms the profiler
  // per block — see perf-structural-ab.js for the method and its three rules.
  //
  // Fed the main window's own per-frame zone GPU so it can check whether the
  // parked view it measures stands in for the route at all. Without that the
  // A/B would silently generalise one static view to the whole map.
  let structuralAB = null;
  if (includeStructuralAB && typeof harness.setStructuralToggle === 'function') {
    const routeZones = {};
    for (const z of profile.zoneStats ?? []) {
      if (z?.gpu && Number.isFinite(z.gpu.sumMs) && profile.frames > 0) routeZones[z.id] = z.gpu.sumMs / profile.frames;
    }
    structuralAB = await runStructuralAB(harness, { routeZones, onProgress });
  }

  say('building', 'assembling the report');
  return buildPerfReport({
    generatedAt,
    msaVersion: context.msaVersion ?? null,
    codename: context.codename ?? null,
    window: {
      frames: profile.frames,
      durationMs: profile.durationMs,
      // What "early" meant for classifyTemporalShape (perf-report.js), sourced
      // from the profiler's own snapshot — see frame-profiler.js#arm.
      earlyWindowMs: profile.earlyWindowMs,
      settleFramesDiscarded: profile.settleFramesDiscarded,
      resolution: context.resolution ?? null,
      sceneName: context.sceneName ?? null,
      floorIndex: context.floorIndex ?? null,
      loop: 'viewer',
    },
    method: {
      // CAPABLE ≠ ARMED (2026-08-11). `gpuStatus.capable` is the static
      // per-device probe (`gpu-zone-timer.js`'s `probeTimestampSupport`) — true
      // for any hardware with the timestamp-query feature, regardless of
      // whether THIS run's `arm()` call actually happened. `gpuTimer` is the
      // arm RESULT captured above, before anything could disarm it, and it is
      // the only place a skipped arm (`{skipped:true, reason:'viewer not
      // started'}`) is visible. Checking capability alone let a skipped arm
      // masquerade as `'timestamp-query'` while every zones[].gpuMs stayed
      // null — the gap this file's own header now documents.
      gpu: gpuStatus?.capable && gpuTimer?.skipped !== true ? 'timestamp-query' : 'frame-only',
      gpuReason:
        gpuTimer?.skipped === true
          ? (gpuTimer?.reason ?? 'GPU zone timer did not arm for this run')
          : (gpuStatus?.reason ?? null),
      cpuClockResolutionMs: profile.clockResolutionMs,
      route,
      timestampPoolOverflowed: gpuStatus?.poolOverflowed ?? false,
    },
    zoneStats: profile.zoneStats,
    zones: ZONES,
    effectZoning: EFFECT_ZONING,
    frame: {
      ...frameStats,
      // PREFER THE PROFILER'S OWN GAP RING. The viewer's caps at 300 samples —
      // fine live, useless for a 60s route (~2,400 frames), where it would
      // describe only the last 12% while the report claimed the whole window.
      gapSamples: profile.gapSamples?.length ? profile.gapSamples : (frameStats.gapSamples ?? []),
      gapDropped: profile.gapDropped ?? 0,
      // Prefer the timestamp-derived frame total. The whole-frame GPU probe is
      // the other source, and this session REFUSES to run while it is armed
      // (it throttles the loop), so without this coverage could never be
      // computed during a profile at all — every run would verdict 'unmeasured'.
      gpuMs: gpuStatus?.frameGpuMs ?? frameStats.gpuMs ?? null,
      // Which zones were still open when a frame hung — the profiler's own
      // correlation, computed in-process. See frame-profiler.js#beginFrame.
      hitchZones: profile.hitchZones ?? null,
    },
    sweep,
    structuralAB,
    pipelineStats: pipelineStatsStart && pipelineStatsEnd ? { start: pipelineStatsStart, end: pipelineStatsEnd } : null,
    depthProxyPoolStats:
      depthProxyPoolStatsStart && depthProxyPoolStatsEnd
        ? { start: depthProxyPoolStatsStart, end: depthProxyPoolStatsEnd }
        : null,
    shaderRebuildStats,
    manifests: harness.getManifests(),
    enabledEffects: context.enabledEffects ?? null,
    vram: harness.readVram?.() ?? null,
    budgetMs: FRAME_BUDGET_MS,
    verbosity,
    // Anomalies the profiler itself detected. Attached rather than folded into
    // the zones so an unbalanced bracket is visible as an INSTRUMENT fault, not
    // mistaken for a property of the thing being measured.
    profilerAnomalies: profile.anomalies,
    gpuTimer: { ...gpuStatus, armResult: gpuTimer ?? null },
  });
}
