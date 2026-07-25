/**
 * gpu-probe.js — the Performance Lab's GPU stopwatch.
 *
 * `renderMsAvgLast120` (vt-pan-viewer) times only CPU command ENCODING; on WebGPU
 * that returns long before the GPU has executed the frame, so it is structurally
 * BLIND to GPU-bound cost — the hitch tail where a frame overruns the ~8.33ms vsync
 * budget and slips whole intervals (the flight-recorder signature: every gap an
 * integer multiple of 8.33ms). This probe times the REAL work via
 * `device.queue.onSubmittedWorkDone()`, which resolves only once the GPU has finished
 * the frame's submitted passes — the SAME primitive vt-pan-viewer already uses for
 * upload backpressure (vt-pan-viewer.js). No `trackTimestamp` device feature, no
 * constructor flag, nothing a cached module can silently disable: it works on any
 * WebGPU device where the last GPU timer reported `supported:false`.
 *
 * Awaiting completion serializes CPU↔GPU (it slows rendering), so the probe is GATED —
 * active ONLY while the perf lab runs a measurement sweep, never in normal play.
 * Single-in-flight + fire-and-forget: one sample every few frames, the render loop
 * never blocks on it.
 *
 * WHY diag/: the `time/one-clock` wall (tools/verify-structure.mjs) allow-lists diag/
 * to read `performance.now()` directly. That wall exists to stop EFFECTS from sampling
 * time privately for animation logic (V2's Water read the clock 8 times and desynced);
 * an instrument measuring the GPU is the opposite — it is not frame logic reading time
 * behind the snapshot's back. `now` is injectable so the sampling logic is Node-testable
 * with a deterministic clock and a fake queue, no browser required.
 */
import { createLogger } from '../core/log.js';

const log = createLogger('gpu-probe');

/**
 * Nearest-rank percentile of a numeric sample, rounded to 0.01ms. Pure.
 * `null` on an empty sample — "no data yet" must never read as 0ms
 * (feedback_instruments_must_not_lie).
 * @param {number[]} samples
 * @param {number} p - 0..1
 * @returns {number|null}
 */
export function percentileOf(samples, p) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

/** Median (p50) — the robust centre, rejecting the hitch tail. `null` on empty. */
export function medianOf(samples) {
  return percentileOf(samples, 0.5);
}

/**
 * A gated GPU-completion timer. See the file header. Drive it from the render loop:
 * `beginFrame()` before submitting the frame's passes, `endFrame(gpuQueue)` after.
 * Read `getStats()` from diagnostics.
 *
 * @param {{now?: () => number, maxSamples?: number}} [opts]
 *   `now` — clock (default performance.now); injected in tests.
 *   `maxSamples` — rolling window size (default 120).
 */
export function createGpuProbe({ now = defaultNow, maxSamples = 120 } = {}) {
  const samples = [];
  let active = false;
  let inFlight = false;
  let pendingStartMs = null;

  function record(ms) {
    if (ms > 0 && Number.isFinite(ms)) {
      samples.push(ms);
      if (samples.length > maxSamples) samples.shift();
    }
  }

  return {
    /**
     * Turn measurement on/off. Turning ON clears stale samples so a sweep reads only
     * its own frames — never last run's numbers.
     */
    setActive(on) {
      const next = !!on;
      if (next && !active) samples.length = 0;
      active = next;
    },
    isActive: () => active,
    /**
     * True while a sample is awaiting GPU completion. THE THROTTLE SIGNAL: the
     * viewer must skip submitting new render work while this is true — see the
     * file header's "measures latency, not cost" post-mortem. Without that gate,
     * the render loop keeps submitting frames every ~8ms regardless, so by the
     * time one `onSubmittedWorkDone()` resolves it has waited through several
     * OTHER frames' pipelined work too, and the "sample" is queue depth, not the
     * cost of the one frame it was meant to isolate.
     */
    isMeasuring: () => inFlight,
    /** Frame start — stamp the clock, but only when idle so we measure one frame at a time. */
    beginFrame() {
      if (active && !inFlight) pendingStartMs = now();
    },
    /**
     * After the frame's passes are submitted, await the GPU finishing them and record
     * the elapsed wall time. No-op when inactive, already sampling, or the queue is
     * missing (a non-WebGPU backend) — so it is always safe to call every frame.
     * @param {{onSubmittedWorkDone?: () => Promise<unknown>}} gpuQueue
     */
    endFrame(gpuQueue) {
      if (!active || inFlight || pendingStartMs == null) return;
      if (!gpuQueue || typeof gpuQueue.onSubmittedWorkDone !== 'function') return;
      inFlight = true;
      const startMs = pendingStartMs;
      pendingStartMs = null;
      Promise.resolve(gpuQueue.onSubmittedWorkDone())
        .then(() => record(now() - startMs))
        .catch((err) => log.error('onSubmittedWorkDone rejected — GPU probe sample dropped:', err))
        .finally(() => {
          inFlight = false;
        });
    },
    /**
     * @returns {{active:boolean, gpuMsMedian:number|null, gpuMsP95:number|null,
     *   gpuMsMax:number|null, sampleCount:number}}
     */
    getStats() {
      return {
        active,
        gpuMsMedian: medianOf(samples),
        gpuMsP95: percentileOf(samples, 0.95),
        gpuMsMax: samples.length ? Math.round(Math.max(...samples) * 100) / 100 : null,
        sampleCount: samples.length,
      };
    },
  };
}

function defaultNow() {
  return performance.now();
}
