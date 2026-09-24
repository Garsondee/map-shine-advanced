/**
 * GPU QUEUE PROBE — "was the GPU side backed up during this load?"
 * (2026-09-24, perf-rig setup).
 *
 * The loading-time report sees the MAIN THREAD well (`worstStallMs`, zone
 * brackets) and the GPU not at all: zone GPU timers are not armed during a
 * load, and pipeline compiles / texture uploads that Chrome's GPU PROCESS
 * executes asynchronously are invisible to any JS-side bracket (the #611
 * trace: CrGpuMain busy 16.5s while CrRendererMain idled). Live 2026-09-24,
 * Docklands warm load: 2 frames rendered in 23s of warming while the worst
 * main-thread stall was 2.7s — a GPU-side stall the report could not name.
 *
 * Method: on a slow timer, ask `device.queue.onSubmittedWorkDone()` and time
 * how long it takes to resolve. It resolves once everything submitted before
 * the call has finished on the GPU, so its latency is a direct reading of the
 * GPU-side backlog at that moment — including a GPU process too busy
 * (compiling, uploading) to service the queue. Only one probe is outstanding
 * at a time, so a long stall is one long sample, not a pile-up; a probe still
 * outstanding at stop() is reported with its age so far rather than dropped.
 *
 * Cost: one tiny promise per tick, no submission of its own. Injectable
 * clock/timers for tests.
 */

const round = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

export const GPU_QUEUE_PROBE_INTERVAL_MS = 250;
/** A sample at or above this is a GPU-side stall worth naming in the report. */
export const GPU_QUEUE_STALL_MS = 250;

/**
 * @param {object} env
 * @param {() => GPUDevice|null} env.getDevice   read lazily every tick (the device appears mid-load)
 * @param {() => number} [env.now]
 * @param {Function} [env.setInterval]
 * @param {Function} [env.clearInterval]
 * @param {number} [env.intervalMs]
 */
export function createGpuQueueProbe(env) {
  const getDevice = env.getDevice;
  const now = env.now ?? (() => performance.now());
  const setIntervalFn = env.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = env.clearInterval ?? ((id) => clearInterval(id));
  const intervalMs = env.intervalMs ?? GPU_QUEUE_PROBE_INTERVAL_MS;

  let timer = null;
  let startedAt = null;
  let outstandingSince = null;
  let generation = 0;
  let samples = [];
  let errors = 0;
  let deviceSeenAtMs = null;

  const tick = () => {
    if (outstandingSince !== null) return;
    let device = null;
    try {
      device = getDevice();
    } catch {
      device = null;
    }
    const queue = device?.queue;
    if (!queue || typeof queue.onSubmittedWorkDone !== 'function') return;
    const t0 = now();
    if (deviceSeenAtMs === null) deviceSeenAtMs = t0 - startedAt;
    outstandingSince = t0;
    const gen = generation;
    let p;
    try {
      p = queue.onSubmittedWorkDone();
    } catch {
      errors++;
      outstandingSince = null;
      return;
    }
    Promise.resolve(p).then(
      () => {
        if (gen !== generation) return;
        samples.push({ atMs: t0 - startedAt, ms: now() - t0 });
        outstandingSince = null;
      },
      () => {
        if (gen !== generation) return;
        errors++;
        outstandingSince = null;
      }
    );
  };

  function start() {
    stopTimer();
    generation++;
    startedAt = now();
    outstandingSince = null;
    samples = [];
    errors = 0;
    deviceSeenAtMs = null;
    timer = setIntervalFn(tick, intervalMs);
    tick();
  }

  function stopTimer() {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  function stop() {
    if (startedAt === null) return null;
    stopTimer();
    const endedAt = now();
    const stillOutstandingMs = outstandingSince !== null ? endedAt - outstandingSince : null;
    const stillOutstandingAtMs = outstandingSince !== null ? outstandingSince - startedAt : null;
    generation++; // late resolutions of the in-flight probe must not mutate a finished result
    const result = summarizeGpuQueueSamples({
      samples,
      windowMs: endedAt - startedAt,
      deviceSeenAtMs,
      stillOutstandingMs,
      stillOutstandingAtMs,
      errors,
    });
    startedAt = null;
    outstandingSince = null;
    return result;
  }

  return { start, stop };
}

/** Pure summary — exported for tests. Times are ms relative to probe start. */
export function summarizeGpuQueueSamples({
  samples,
  windowMs,
  deviceSeenAtMs = null,
  stillOutstandingMs = null,
  stillOutstandingAtMs = null,
  errors = 0,
}) {
  const all = [...samples];
  if (Number.isFinite(stillOutstandingMs)) all.push({ atMs: stillOutstandingAtMs, ms: stillOutstandingMs, unfinished: true });
  const lat = all.map((s) => s.ms).sort((a, b) => a - b);
  const pct = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : null);
  const stalls = all.filter((s) => s.ms >= GPU_QUEUE_STALL_MS);
  return {
    windowMs: round(windowMs),
    deviceSeenAtMs: round(deviceSeenAtMs),
    sampleCount: all.length,
    p50Ms: round(pct(0.5)),
    p95Ms: round(pct(0.95)),
    maxMs: round(lat.length ? lat[lat.length - 1] : null),
    // Sum of the stalled samples' latencies — how long, in total, the GPU side
    // was measurably backed up. Samples never overlap (one outstanding at a
    // time), so this cannot double-count.
    stalledMs: round(stalls.reduce((a, s) => a + s.ms, 0)),
    stallCount: stalls.length,
    worst: [...all]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5)
      .map((s) => ({ atMs: round(s.atMs), ms: round(s.ms), ...(s.unfinished ? { unfinished: true } : {}) })),
    stillOutstandingMs: round(stillOutstandingMs),
    errors,
  };
}
