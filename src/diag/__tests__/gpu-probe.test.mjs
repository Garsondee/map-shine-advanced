/**
 * gpu-probe.test.mjs — the perf-lab GPU stopwatch. The percentile/median math and the
 * gated single-in-flight sampling are pure JS driven by an injected clock + a fake
 * WebGPU queue, so they test in Node with no browser. The live `onSubmittedWorkDone`
 * timing against a real device is browser-verified (CONVENTIONS §4).
 */
import { createGpuProbe, percentileOf, medianOf } from '../gpu-probe.js';

/** Flush pending microtasks + one macrotask so a scheduled onSubmittedWorkDone().then lands. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function run(t) {
  const { ok } = t;

  // --- percentileOf / medianOf ---------------------------------------------
  {
    ok('empty → null (never lies as 0)', percentileOf([], 0.5) === null && medianOf([]) === null);
    ok('single sample is every percentile', medianOf([7]) === 7 && percentileOf([7], 0.95) === 7);
    ok('median of a spread rejects outliers', medianOf([8, 8, 8, 8, 80]) === 8);
    ok('p95 catches the hitch tail', percentileOf([8, 8, 8, 8, 80], 0.95) === 80);
    ok('rounded to 0.01ms', medianOf([8.333333]) === 8.33);
    ok('non-array → null', percentileOf(null, 0.5) === null);
  }

  // --- inert until activated -----------------------------------------------
  {
    const probe = createGpuProbe({ now: () => 0 });
    const q = { onSubmittedWorkDone: () => Promise.resolve() };
    probe.beginFrame();
    probe.endFrame(q);
    await tick();
    const s = probe.getStats();
    ok('inactive probe records nothing', s.sampleCount === 0 && s.active === false);
    ok('inactive stats are null, not 0', s.gpuMsMedian === null && s.gpuMsP95 === null);
  }

  // --- one clean measurement -----------------------------------------------
  {
    const times = [100, 108.3]; // beginFrame stamp, then record's end read
    let i = 0;
    const now = () => times[Math.min(i++, times.length - 1)];
    const probe = createGpuProbe({ now });
    const q = { onSubmittedWorkDone: () => Promise.resolve() };
    probe.setActive(true);
    ok(
      'active with no samples yet reads as measuring, not 0ms',
      probe.getStats().active === true && probe.getStats().sampleCount === 0
    );
    probe.beginFrame();
    probe.endFrame(q);
    await tick();
    const s = probe.getStats();
    ok('a completed frame yields exactly one sample', s.sampleCount === 1);
    ok('the sample is GPU-completion minus frame-start (8.3ms)', s.gpuMsMedian === 8.3);
  }

  // --- single-in-flight: no overlapping measurements -----------------------
  {
    let resolveWork = null;
    const q = { onSubmittedWorkDone: () => new Promise((r) => (resolveWork = r)) };
    let n = 0;
    const now = () => [10, 30, /* second attempt start (should be ignored) */ 999, 999][Math.min(n++, 3)];
    const probe = createGpuProbe({ now });
    probe.setActive(true);
    probe.beginFrame(); // stamp 10
    probe.endFrame(q); // in flight, not resolved
    probe.beginFrame(); // must NOT restamp while in flight
    probe.endFrame(q); // must NOT start a second measurement
    resolveWork(); // finish the first
    await tick();
    const s = probe.getStats();
    ok('a second frame does not start while one is in flight', s.sampleCount === 1);
    ok('the one sample used the first frame-start (30-10=20)', s.gpuMsMedian === 20);
  }

  // --- isMeasuring() — the viewer's throttle signal -------------------------
  {
    let resolveWork = null;
    const q = { onSubmittedWorkDone: () => new Promise((r) => (resolveWork = r)) };
    const probe = createGpuProbe({ now: () => 0 });
    probe.setActive(true);
    ok('not measuring before any frame is submitted', probe.isMeasuring() === false);
    probe.beginFrame();
    probe.endFrame(q);
    ok('measuring while the GPU has not confirmed completion', probe.isMeasuring() === true);
    resolveWork();
    await tick();
    ok('measuring clears once the sample lands', probe.isMeasuring() === false);
  }

  // --- a non-WebGPU / missing queue is safe --------------------------------
  {
    const probe = createGpuProbe({ now: () => 0 });
    probe.setActive(true);
    probe.beginFrame();
    probe.endFrame(undefined);
    probe.endFrame({}); // no onSubmittedWorkDone
    await tick();
    ok('a missing GPU queue records nothing and never throws', probe.getStats().sampleCount === 0);
  }

  // --- re-activating clears stale samples ----------------------------------
  {
    const times = [0, 5, 0, 9];
    let i = 0;
    const now = () => times[Math.min(i++, times.length - 1)];
    const probe = createGpuProbe({ now });
    const q = { onSubmittedWorkDone: () => Promise.resolve() };
    probe.setActive(true);
    probe.beginFrame();
    probe.endFrame(q);
    await tick();
    ok('first run recorded a sample', probe.getStats().sampleCount === 1);
    probe.setActive(false);
    probe.setActive(true); // ON transition clears
    ok('re-activating drops the previous run’s samples', probe.getStats().sampleCount === 0);
  }
}
