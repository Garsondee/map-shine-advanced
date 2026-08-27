/**
 * Node tests for graph/render-cost-signal.js — the whole-frame EMA folder
 * that feeds RenderScaleGovernor#update(). Pure arithmetic, no mocks.
 */
import { createFrameCostSignal } from '../render-cost-signal.js';

export function run(t) {
  const { ok } = t;

  {
    const s = createFrameCostSignal({ emaAlpha: 0.5 });
    ok('costMs is 0 before any sample', s.costMs() === 0);
    ok('the FIRST sample seeds the EMA exactly (no half-weighted zero)', s.update(20) === 20);
    ok('costMs matches what update() just returned', s.costMs() === 20);
    const after = s.update(10); // alpha 0.5: 20 + 0.5*(10-20) = 15
    ok('a second sample folds toward the new value, not straight to it', after === 15);
    ok('costMs reflects the fold', s.costMs() === 15);
  }

  // Bad input folds as 0, never corrupts the EMA with NaN.
  {
    const s = createFrameCostSignal({ emaAlpha: 0.5 });
    s.update(10);
    ok('NaN folds as 0, not NaN', s.update(NaN) === 5 && Number.isFinite(s.costMs()));
    const s2 = createFrameCostSignal({ emaAlpha: 0.5 });
    s2.update(10);
    ok('negative folds as 0', s2.update(-5) === 5);
    const s3 = createFrameCostSignal({ emaAlpha: 0.5 });
    ok('undefined as the FIRST sample seeds at 0, not NaN', s3.update(undefined) === 0);
  }

  // reset() drops the EMA back to "before any sample", same as construction.
  {
    const s = createFrameCostSignal({ emaAlpha: 0.5 });
    s.update(100);
    s.reset();
    ok('reset drops costMs back to 0', s.costMs() === 0);
    ok('the next sample after reset seeds exactly again (no stale weighting)', s.update(4) === 4);
  }

  // A bogus alpha falls back to the documented default rather than throwing
  // or producing a broken (e.g. 0 or >1) smoothing factor.
  {
    const s = createFrameCostSignal({ emaAlpha: 0 });
    s.update(10);
    ok('alpha=0 (invalid) falls back to the default, not a frozen EMA', s.update(0) !== 10);
    const s2 = createFrameCostSignal({ emaAlpha: -1 });
    ok('a negative alpha does not throw at construction', typeof s2.update(1) === 'number');
    const s3 = createFrameCostSignal({});
    ok('a missing alpha option does not throw', typeof s3.update(1) === 'number');
  }
}
