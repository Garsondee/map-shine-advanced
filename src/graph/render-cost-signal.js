/**
 * RENDER COST SIGNAL — a small, pure, whole-frame EMA folder that feeds
 * `RenderScaleGovernor#update()` (`v3-perf.js`) a single `costMs` per frame.
 *
 * Deliberately NOT `V3PerfMonitor` (`v3-perf.js`'s own class) — that folds
 * PER-PASS timings keyed to old stage names (`streaming`, `unifiedGeometry`,
 * `effects`) matching nothing in today's render loop, and the governor only
 * ever consumes ONE number (`V3PerfMonitor#costEstimateMs()` =
 * `max(cpuTotal, gpuTotal)`), never the per-pass detail. `V3PerfMonitor`
 * stays restored in `v3-perf.js` for its own sake (deleting half a
 * historical file is worse than an unused export, and its own tests still
 * pass) — this module is its live replacement caller-side.
 *
 * The value this gets fed is `vt-pan-viewer.js#renderFrame`'s own `gapMs` —
 * true wall-clock time between successive frames. This is the ONE always-on
 * (every player, every frame, zero new instrumentation) signal sensitive to
 * real GPU fill-rate cost, the vsync-slip tail — see
 * `docs/planning/Performance-Ceiling-Analysis-2026-08-26.md` for why the
 * real per-pass CPU/GPU zone timers were ruled out for this (diagnostic-
 * only, real armed-cost: timestamp-query pools, GPU-readback promise
 * chains) and why `frameTimes`/`cpuEncodeMs` was ALSO ruled out as a
 * synthesis input for a fake CPU/GPU split (the felt-vs-encode difference
 * is dominated by the vsync-wait baseline and non-command-encoding CPU
 * work, not real GPU cost — feeding it through the governor's r²-scaling
 * up-predictor would actively mislead it, not just add noise).
 *
 * @module graph/render-cost-signal
 */

const DEFAULT_EMA_ALPHA = 0.1;

/**
 * @param {object} [options]
 * @param {number} [options.emaAlpha=0.1] - EMA smoothing factor, `(0, 1]`.
 * @returns {{update: (ms: number) => number, costMs: () => number, reset: () => void}}
 */
export function createFrameCostSignal(options = {}) {
  const alpha =
    Number.isFinite(options.emaAlpha) && options.emaAlpha > 0 && options.emaAlpha <= 1
      ? options.emaAlpha
      : DEFAULT_EMA_ALPHA;
  let ema = null;

  return {
    /**
     * Fold one frame's cost sample in. Non-finite/negative input folds as `0`
     * rather than corrupting the EMA with `NaN` — a single bad sample decays
     * out over a few frames instead of poisoning every reading after it.
     * @param {number} ms
     * @returns {number} the EMA immediately after folding — same as calling
     *   `costMs()` right after.
     */
    update(ms) {
      const v = Number.isFinite(ms) && ms >= 0 ? ms : 0;
      ema = ema === null ? v : ema + alpha * (v - ema);
      return ema;
    },
    /** @returns {number} the current EMA, or `0` before the first sample. */
    costMs() {
      return ema ?? 0;
    },
    /** Discard accumulated state (e.g. on a scene/floor change) — matches
     * `RenderScaleGovernor#reset()`'s own "keep the rung, drop the streaks"
     * posture: a fresh EMA is appropriate, a fresh render scale is not. */
    reset() {
      ema = null;
    },
  };
}
