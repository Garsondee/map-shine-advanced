/**
 * THE UI PERF ROW — verification (docs/holy/UI-Testament.md §9, Law 11).
 * "Steady-state panel cost ≤ 0.3 ms" is the load-bearing budget this suite
 * proves the verdict logic against.
 */
import { beginUiTick, endUiTick, getUiPerfSnapshot, resetUiPerf, UI_PERF_BUDGET_MS } from '../ui-perf.js';

export function run(t) {
  const { ok } = t;

  ok('the budget matches Law 11 exactly', UI_PERF_BUDGET_MS === 0.3);

  // ---- unmeasured before any tick --------------------------------------
  {
    resetUiPerf();
    const snap = getUiPerfSnapshot();
    ok('zero ticks is an honest "unmeasured", not a silent 0ms', snap.verdict === 'unmeasured');
    ok('unmeasured has no mean', snap.meanMs === null);
    ok('unmeasured has no max', snap.maxMs === null);
    ok('count is 0', snap.count === 0);
  }

  // ---- a single deterministic tick, driven by the injected nowMs --------
  {
    resetUiPerf();
    const t0 = beginUiTick();
    endUiTick(t0, t0 + 0.1); // 0.1ms elapsed, deterministic
    const snap = getUiPerfSnapshot();
    ok('one tick recorded', snap.count === 1);
    ok('mean equals the single sample', Math.abs(snap.meanMs - 0.1) < 1e-9);
    ok('max equals the single sample', Math.abs(snap.maxMs - 0.1) < 1e-9);
    ok('0.1ms is well within the 0.3ms budget', snap.verdict === 'within');
  }

  // ---- mean and max over several ticks -----------------------------------
  {
    resetUiPerf();
    const samples = [0.1, 0.2, 0.05, 0.4];
    for (const s of samples) {
      const start = 100; // arbitrary fixed start — endUiTick's nowMs param controls elapsed directly
      endUiTick(start, start + s);
    }
    const snap = getUiPerfSnapshot();
    ok('count matches the number of ticks', snap.count === samples.length);
    const expectedMean = samples.reduce((a, b) => a + b, 0) / samples.length;
    // getUiPerfSnapshot() rounds to 3 decimals for display (this module's own
    // `round()`) — tolerance has to cover that rounding, not just float error.
    ok('mean is the arithmetic mean of every sample', Math.abs(snap.meanMs - expectedMean) < 0.001);
    ok('max is the largest single sample', Math.abs(snap.maxMs - 0.4) < 0.001);
  }

  // ---- the over-budget verdict -------------------------------------------
  {
    resetUiPerf();
    const start = 0;
    endUiTick(start, start + 0.5); // 0.5ms mean, above the 0.3ms budget
    const snap = getUiPerfSnapshot();
    ok('a mean above budgetMs is verdict:over', snap.verdict === 'over');
  }

  // ---- exactly at budget is within, not over -----------------------------
  {
    resetUiPerf();
    const start = 0;
    endUiTick(start, start + UI_PERF_BUDGET_MS);
    const snap = getUiPerfSnapshot();
    ok('a mean exactly AT budgetMs is within, not over (the check is strictly-greater)', snap.verdict === 'within');
  }

  // ---- malformed input is ignored, never throws, never corrupts state ----
  {
    resetUiPerf();
    endUiTick(undefined, 5); // no valid start
    // NaN, not undefined — passing `undefined` explicitly for a defaulted
    // parameter re-triggers the default (`= performance.now()`), which is
    // NOT what "no valid now" means to test; NaN bypasses the default and
    // actually exercises the Number.isFinite(nowMs) guard.
    endUiTick(0, NaN); // no valid now
    endUiTick(10, 5); // a NEGATIVE elapsed (clock ran backwards) — rejected as a bad sample
    const snap = getUiPerfSnapshot();
    ok('none of the malformed calls recorded a sample', snap.count === 0);
    ok('still an honest unmeasured verdict after only bad input', snap.verdict === 'unmeasured');
  }

  // ---- beginUiTick returns something endUiTick can consume in the real path --
  {
    resetUiPerf();
    const started = beginUiTick();
    ok('beginUiTick returns a finite number (a real clock read)', Number.isFinite(started));
    endUiTick(started); // real clock for both ends — should not throw, elapsed >= 0 basically always
    const snap = getUiPerfSnapshot();
    ok('a real begin/end pair records exactly one sample', snap.count === 1);
  }

  // ---- resetUiPerf clears everything --------------------------------------
  {
    endUiTick(0, 1);
    endUiTick(0, 2);
    resetUiPerf();
    const snap = getUiPerfSnapshot();
    ok('reset clears count/mean/max back to unmeasured', snap.verdict === 'unmeasured' && snap.count === 0);
  }

  resetUiPerf(); // leave the module clean for any other suite sharing this process
}
