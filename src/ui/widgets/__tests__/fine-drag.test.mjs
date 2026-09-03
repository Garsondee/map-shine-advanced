/**
 * fine-drag.js's pure half: given a drag's start value and how far the
 * pointer has moved, what value the slider shows. The DOM-wiring half
 * (`attachFineDrag`) is browser-verified live, same convention as every
 * other pointer-driven widget in this directory (CONVENTIONS.md §4).
 */
import { computeFineDragValue, FINE_STEP_DIVISOR } from '../fine-drag.js';

export function run(t) {
  const { ok } = t;

  // mythica-machina-press#491's own motivating case: flameWindPush is
  // min:0, max:200, step:0.05, default 1.5 — a normal drag on a ~150px
  // track moves over a unit of value per pixel, well past the precision
  // needed near a default of 1.5.
  const flameWindPush = { min: 0, max: 200, step: 0.05 };
  ok(
    'one pixel of Shift-drag moves the value by step/FINE_STEP_DIVISOR, not a whole track-width fraction',
    computeFineDragValue({ startValue: 1.5, deltaPx: 1, ...flameWindPush }) === 1.5 + 0.05 / FINE_STEP_DIVISOR
  );
  ok(
    '100px of Shift-drag is 100x that — still a small, precise nudge, not a jump across the range',
    computeFineDragValue({ startValue: 1.5, deltaPx: 100, ...flameWindPush }) === 2
  );
  ok(
    'dragging the other way subtracts',
    computeFineDragValue({ startValue: 1.5, deltaPx: -100, ...flameWindPush }) === 1
  );
  ok(
    'a Shift-drag is finer than a normal drag could ever land on the schema step: many fine steps sit strictly between two adjacent multiples of the declared step',
    Number.isFinite(FINE_STEP_DIVISOR) && FINE_STEP_DIVISOR > 1
  );

  ok(
    'clamps at the max — dragging far past the end does not overshoot the range',
    computeFineDragValue({ startValue: 199, deltaPx: 1_000_000, min: 0, max: 200, step: 0.05 }) === 200
  );
  ok(
    'clamps at the min',
    computeFineDragValue({ startValue: 1, deltaPx: -1_000_000, min: 0, max: 200, step: 0.05 }) === 0
  );

  ok(
    'a missing/zero step falls back to a 100th of the range rather than dividing by zero',
    Number.isFinite(computeFineDragValue({ startValue: 0, deltaPx: 1, min: 0, max: 1, step: 0 }))
  );
  ok(
    'a non-finite step falls back the same way',
    Number.isFinite(computeFineDragValue({ startValue: 0, deltaPx: 1, min: 0, max: 1, step: NaN }))
  );

  // The classic `0.1 + 0.2` shape — a start value and a per-pixel delta that
  // don't divide evenly should still round to a clean number, not carry a
  // float tail into the readout or the committed value.
  const noisy = computeFineDragValue({ startValue: 0.1, deltaPx: 3, min: 0, max: 1, step: 0.1 });
  ok('rounds away float noise instead of returning something like 0.13999999999999999', noisy === 0.13);
}
