/**
 * Node tests for v3-perf.js — the performance contract (Forward+ §16.3 P1) and
 * the render-scale governor (P2). Pure logic; no mocks needed beyond numbers.
 * Run via ./run-tests.mjs.
 */
import {
  computeRenderSize, V3PerfMonitor, RenderScaleGovernor, buildPerfRows,
} from '../v3-perf.js';

export function run(t) {
  const { ok } = t;

  // computeRenderSize — the identity path must be EXACT; sub-1 floors to even.
  {
    const exact = computeRenderSize(2559, 1079, 1);
    ok('scale 1 exact (odd dims preserved)', exact.width === 2559 && exact.height === 1079);
    const half = computeRenderSize(1600, 900, 0.5);
    ok('0.5 halves cleanly', half.width === 800 && half.height === 450);
    const snapped = computeRenderSize(1001, 333, 0.85);
    ok('sub-1 floors to even', snapped.width === 850 && snapped.height === 282);
    ok('never below 2', computeRenderSize(2, 2, 0.5).width === 2);
    ok('bad scale treated as 1', computeRenderSize(100, 100, NaN).width === 100);
    ok('scale > 1 clamped to 1', computeRenderSize(100, 100, 2).width === 100);
  }

  // V3PerfMonitor — folding, latching GPU results, budgets, cost estimate.
  {
    const m = new V3PerfMonitor({ emaAlpha: 0.5 });
    m.update(new Map([['a', 4], ['b', 2]]), new Map([['a', 8]]));
    ok('cost = max(cpuTotal, gpuTotal)', m.costEstimateMs() === 8);
    m.update(new Map([['a', 4], ['b', 2]]), null);
    const rep = m.getReport();
    ok('frames counted', rep.frames === 2);
    ok('cpu total last', rep.cpuTotal.lastMs === 6);
    const a = rep.passes.find((p) => p.pass === 'a');
    ok('gpu result latched across frames', a.gpuLastMs === 8);
    ok('unknown pass gets default budget', a.budgetMs === 2.0);
    ok('over-budget flagged', a.overBudget === true);
    const b = rep.passes.find((p) => p.pass === 'b');
    ok('under-budget pass unflagged', b.overBudget === false && b.gpuLastMs === null);
    ok('known pass budget honored', new V3PerfMonitor().budgetFor('lighting') === 3.0);
    const rows = buildPerfRows(rep);
    ok('perf rows include TOTAL', rows.length === 3 && rows[rows.length - 1].pass === 'TOTAL');
    ok('monitor tolerates bad input', (() => { m.update(null); return m.getReport().frames === 2; })());
  }

  // RenderScaleGovernor — warmup immunity, down-step, cooldown spacing, recovery.
  {
    const gov = new RenderScaleGovernor({
      frameBudgetMs: 10, warmupFrames: 5, downFrames: 3, upFrames: 4,
      cooldownFrames: 6, highWater: 1.2, lowWater: 0.7,
    });
    ok('starts at full scale', gov.scale === 1.0);

    let changedDuringWarmup = false;
    for (let i = 0; i < 5; i++) changedDuringWarmup = gov.update(100).changed || changedDuringWarmup;
    ok('warmup immune to over-budget', !changedDuringWarmup && gov.scale === 1.0);

    gov.update(100); gov.update(100);
    ok('needs the full down-streak', gov.scale === 1.0);
    const down = gov.update(100);
    ok('steps down one rung after streak', down.changed && down.scale === 0.85);

    // Cooldown spaces changes: sustained over-budget keeps stepping, but only
    // once per cooldown window.
    let stepAt = -1; let stepScale = 0;
    for (let i = 0; i < 6; i++) {
      const r = gov.update(100);
      if (r.changed) { stepAt = i; stepScale = r.scale; }
    }
    ok('cooldown spaces consecutive steps', stepAt === 5 && stepScale === 0.7);

    // Recovery: predicted cost at the next rung up must clear the low-water
    // line for upFrames consecutive frames (and the cooldown must expire).
    let up = null;
    for (let i = 0; i < 12 && !up; i++) {
      const r = gov.update(1);
      if (r.changed) up = r;
    }
    ok('recovers upward on sustained headroom', up && up.scale === 0.85);
    ok('state snapshot names the change', gov.state().lastChange?.reason === 'headroom');
  }

  // Governor clamping + floor behavior.
  {
    const gov = new RenderScaleGovernor({
      frameBudgetMs: 1, warmupFrames: 0, downFrames: 1, cooldownFrames: 0, minScale: 0.7,
    });
    for (let i = 0; i < 50; i++) gov.update(100);
    ok('never leaves the min-scale rung', gov.scale === 0.7);
    ok('ladder respected minScale', gov.state().ladder.every((s) => s >= 0.7));

    const fixed = new RenderScaleGovernor({ ladder: [0.3], minScale: 0.5, maxScale: 1 });
    ok('empty filtered ladder falls back sanely', fixed.scale >= 0.5 && fixed.scale <= 1);
  }

  // Governor ignores a single spike (streak resets).
  {
    const gov = new RenderScaleGovernor({
      frameBudgetMs: 10, warmupFrames: 0, downFrames: 3, cooldownFrames: 0,
    });
    gov.update(100); gov.update(100); gov.update(1); gov.update(100); gov.update(100);
    ok('interrupted streak does not step', gov.scale === 1.0);
  }
}
