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
 * @module diag/perf-session
 */
import { buildPerfReport } from './perf-report.js';
import { EFFECT_ZONING, FRAME_BUDGET_MS, ZONES } from './perf-zones.js';
import { DEFAULT_SETTLE_FRAMES } from './frame-profiler.js';

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
    verbosity = 'default',
    route = null,
    /** A promise that resolves when the workload ends; replaces `measureFrames`. */
    measureUntil = null,
    onProgress = null,
    generatedAt = null,
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
  try {
    say('arming', 'starting the GPU zone timer');
    gpuTimer = harness.setGpuZoneTimer(true);

    harness.resetFrameStats();
    harness.armProfiler({ settleFrames });
    armed = true;

    say('settling', `${settleFrames} frames discarded (shader compile, first residency pass, first bake)`);
    await harness.waitFrames(settleFrames);

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

  let sweep = null;
  if (includeSweep && typeof harness.runSweep === 'function') {
    say('sweeping', 'per-effect on/off marginal cost, as an independent cross-check');
    sweep = await harness.runSweep();
  }

  say('building', 'assembling the report');
  return buildPerfReport({
    generatedAt,
    msaVersion: context.msaVersion ?? null,
    codename: context.codename ?? null,
    window: {
      frames: profile.frames,
      durationMs: profile.durationMs,
      settleFramesDiscarded: profile.settleFramesDiscarded,
      resolution: context.resolution ?? null,
      sceneName: context.sceneName ?? null,
      floorIndex: context.floorIndex ?? null,
      loop: 'viewer',
    },
    method: {
      gpu: gpuStatus?.capable ? 'timestamp-query' : 'frame-only',
      gpuReason: gpuStatus?.reason ?? null,
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
    },
    sweep,
    pipelineStats: pipelineStatsStart && pipelineStatsEnd ? { start: pipelineStatsStart, end: pipelineStatsEnd } : null,
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
