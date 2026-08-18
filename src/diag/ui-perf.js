/**
 * diag/ui-perf.js — Law 11's OWN row (docs/holy/UI-Testament.md §9, U6):
 * "Steady-state panel cost ≤ 0.3 ms... The UI's own cost is a row in the
 * perf report — an instrument that exempts itself is lying."
 *
 * ============================================================================
 * WHY THIS IS NOT A perf-zones.js ZONE
 * ============================================================================
 *
 * Every `'frame'`-stage zone in `perf-zones.js` (`tick.camera`,
 * `tick.tokenSync`, `tick.continuousInputs`, …) is a pre-plan CPU tick
 * INSIDE `renderFrame` — the same function that also runs the pass plan, on
 * the same `requestAnimationFrame` chain, validated against `graph/
 * passes.js`'s real pass/stage graph. `boot.js#pumpAstrolabe` is a
 * SEPARATE, independent `requestAnimationFrame` registration — fade/cue-
 * preview pumping was folded INTO it specifically to avoid a SECOND
 * independent loop beside the render loop (see `pumpAstrolabe`'s own
 * comment), but it never joins `runFramePlan`'s pass sequence. Declaring a
 * zone with `stage:'frame', pass:null` for work that is not actually inside
 * `renderFrame` would misstate WHERE the cost lives, even if the number
 * itself were honestly measured — `perf-zones.js`'s own header is explicit
 * that pass-level zones must never become a second hand-kept copy of the
 * frame order. This module mirrors `perf-hud.js`'s OWN self-measurement
 * idiom instead ("IT MEASURES ITSELF") — a simple accumulator, not the
 * zone/profiler machinery built for a different shape of cost.
 *
 * ============================================================================
 * WHY THIS LIVES IN diag/, NOT boot.js
 * ============================================================================
 *
 * `pumpAstrolabe`'s own comment records that `boot.js` is not allowed to
 * call `performance.now()` itself (`time/one-clock`, `tools/verify-
 * structure.mjs` — exempts only `diag/` and `core/frame-clock.js`).
 * `beginUiTick`/`endUiTick` make that call from WITHIN their allowed home;
 * `boot.js` only ever calls these two exported functions, never touches the
 * clock directly.
 *
 * @module diag/ui-perf
 */

/** Law 11's own number (UI-Testament.md §9). */
export const UI_PERF_BUDGET_MS = 0.3;

let count = 0;
let totalMs = 0;
let maxMs = 0;

/**
 * Start a tick. @returns {number} an opaque start timestamp — pass straight
 * to {@link endUiTick}, never inspect it.
 */
export function beginUiTick() {
  return performance.now();
}

/**
 * End a tick started by {@link beginUiTick} and record it.
 * @param {number} startedAt - `beginUiTick()`'s own return value.
 * @param {number} [nowMs] - the current timestamp; defaults to a real clock
 *   read. Exposed so tests can drive elapsed time deterministically without
 *   depending on real wall-clock jitter — production callers never pass it.
 */
export function endUiTick(startedAt, nowMs = performance.now()) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(nowMs)) return;
  const elapsed = nowMs - startedAt;
  if (elapsed < 0) return; // a clock that ran backwards is not a sample, it's a bug elsewhere
  count++;
  totalMs += elapsed;
  if (elapsed > maxMs) maxMs = elapsed;
}

/**
 * The current window's snapshot, ready to drop into a perf report row.
 * `count: 0` (no tick recorded yet, e.g. right after `resetUiPerf()`) is an
 * honest `verdict:'unmeasured'` — never a silent 0ms, which would read as
 * "measured and free" rather than "not measured at all"
 * (`feedback_instruments_must_not_lie`).
 * @returns {{count: number, meanMs: number|null, maxMs: number|null, budgetMs: number, verdict: 'over'|'within'|'unmeasured'}}
 */
export function getUiPerfSnapshot() {
  if (count === 0) {
    return { count: 0, meanMs: null, maxMs: null, budgetMs: UI_PERF_BUDGET_MS, verdict: 'unmeasured' };
  }
  const meanMs = totalMs / count;
  return {
    count,
    meanMs: round(meanMs),
    maxMs: round(maxMs),
    budgetMs: UI_PERF_BUDGET_MS,
    verdict: meanMs > UI_PERF_BUDGET_MS ? 'over' : 'within',
  };
}

/** Start a fresh measurement window. Mainly for tests; nothing in the live
 * renderer needs to reset this mid-session today. */
export function resetUiPerf() {
  count = 0;
  totalMs = 0;
  maxMs = 0;
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
