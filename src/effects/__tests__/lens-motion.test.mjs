/**
 * Node verification for effects/lens-motion.js — every function here is pure,
 * so this pins the actual NUMBERS against V2's own transcribed formulas,
 * exactly like `fluid-pack.js`'s own round-trip tests pin its pure math.
 */
import {
  computeAutoFocusAmount,
  pickAutoFocusIntervalSec,
  computeAutoFocusEventDurationSec,
  computeAutoFocusShiftPx,
  computeZoomTriggerStrength,
  computeCameraMotionBlurPx,
  computeZoomMotionBlurPx,
  computeLightBurnDecayFactor,
  computeLightBurnDarknessGate,
} from '../lens-motion.js';

export function run(t) {
  const { ok } = t;

  // ── computeAutoFocusAmount — the rise/hold/fall envelope ─────────────────
  ok('phase 0 is fully sharp (amount 0)', computeAutoFocusAmount(0) === 0);
  ok('phase 1 is fully sharp again (amount 0)', computeAutoFocusAmount(1) === 0);
  ok('phase 0.7 (inside the 0.55-0.85 hold) is fully blurred', computeAutoFocusAmount(0.7) === 1);
  ok('phase 0.55 (the rise/hold boundary) reaches exactly 1', computeAutoFocusAmount(0.55) === 1);
  ok('phase 0.85 (the hold/fall boundary) is still exactly 1', computeAutoFocusAmount(0.85) === 1);
  ok(
    'rising is monotonically increasing (a mid-rise sample beats an earlier one)',
    computeAutoFocusAmount(0.4) > computeAutoFocusAmount(0.2) &&
      computeAutoFocusAmount(0.2) > computeAutoFocusAmount(0.05)
  );
  ok(
    'falling is monotonically decreasing',
    computeAutoFocusAmount(0.9) > computeAutoFocusAmount(0.95) &&
      computeAutoFocusAmount(0.95) > computeAutoFocusAmount(0.99)
  );
  ok(
    'out-of-range phase clamps rather than extrapolating',
    computeAutoFocusAmount(-1) === 0 && computeAutoFocusAmount(2) === 0
  );

  // ── pickAutoFocusIntervalSec ──────────────────────────────────────────────
  ok(
    'stays within [min, max] across many draws',
    (() => {
      let seed = 7;
      const rng = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      for (let i = 0; i < 200; i++) {
        const v = pickAutoFocusIntervalSec(10, 45, rng);
        if (v < 10 || v > 45) return false;
      }
      return true;
    })()
  );
  ok(
    'a max at or below min collapses to the min (never throws, never inverts)',
    pickAutoFocusIntervalSec(20, 5, () => 0.5) === 20
  );
  ok('a min below the 0.5s floor is raised to it', pickAutoFocusIntervalSec(0, 0, () => 0) === 0.5);

  // ── computeAutoFocusEventDurationSec ──────────────────────────────────────
  ok('an ordinary (strength 1) pulse keeps its base duration', computeAutoFocusEventDurationSec(2, 1) === 2);
  ok('a stronger pulse (strength > 1) resolves FASTER, never slower', computeAutoFocusEventDurationSec(2, 2) < 2);
  ok(
    'a WEAK strength is floored at a 0.6 divisor — it cannot stretch the pulse past base/0.6',
    Math.abs(computeAutoFocusEventDurationSec(2, 0.1) - 2 / 0.6) < 1e-9
  );
  ok(
    'a strong (>0.6) strength divides by ITSELF, not the floor — this is where "resolves faster" comes from',
    Math.abs(computeAutoFocusEventDurationSec(2, 10) - 2 / 10) < 1e-9
  );
  ok('never collapses below the 0.05s hard floor', computeAutoFocusEventDurationSec(0.001, 100) === 0.05);

  // ── computeAutoFocusShiftPx ────────────────────────────────────────────────
  ok(
    'magnitude never exceeds maxShiftPx (drawn from the top 55%, strength-scaled up to 1.8x)',
    (() => {
      let seed = 3;
      const rng = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      for (let i = 0; i < 200; i++) {
        const { x, y } = computeAutoFocusShiftPx(6, 1, rng);
        const mag = Math.hypot(x, y);
        if (mag > 6 * 1.8 + 1e-6) return false;
      }
      return true;
    })()
  );
  ok(
    'zero max shift is always the zero vector',
    (() => {
      const { x, y } = computeAutoFocusShiftPx(0, 1, () => 0.5);
      return x === 0 && y === 0;
    })()
  );

  // ── computeZoomTriggerStrength ─────────────────────────────────────────────
  ok('below threshold does not trigger', computeZoomTriggerStrength(1, 3, 1) === null);
  ok('at/above threshold triggers with a real strength', computeZoomTriggerStrength(5, 3, 1) !== null);
  ok('negative velocity is treated by magnitude, not sign', computeZoomTriggerStrength(-5, 3, 1) !== null);
  ok('triggered strength never exceeds the 2.0 ceiling', computeZoomTriggerStrength(1000, 3, 1) === 2.0);

  // ── computeCameraMotionBlurPx — a real reducer, previous state explicit ────
  {
    const params = { strength: 2, maxPx: 10, smoothingSeconds: 0 };
    // smoothingSeconds=0 -> alpha=1 -> the smoothed value snaps straight to raw.
    const frame1 = computeCameraMotionBlurPx(
      { dxWorld: 10, dyWorld: 0, viewW: 100, viewH: 100, screenW: 1000, screenH: 1000 },
      { x: 0, y: 0 },
      1 / 60,
      params
    );
    // dxWorld positive (camera moved right) -> world appears to slide LEFT -> negative x.
    ok('panning right smears in the negative-x direction (world slides left underneath)', frame1.smoothedPx.x < 0);
    ok('zero dy produces zero y smear', frame1.smoothedPx.y === 0);
    ok('blur is clamped to maxPx', Math.abs(frame1.blurPx.x) <= 10 + 1e-9);
  }
  {
    // A stationary camera (zero delta every frame) must settle to exactly zero.
    let state = { x: 5, y: -5 };
    const params = { strength: 1, maxPx: 100, smoothingSeconds: 0.2 };
    for (let i = 0; i < 500; i++) {
      const r = computeCameraMotionBlurPx(
        { dxWorld: 0, dyWorld: 0, viewW: 100, viewH: 100, screenW: 1000, screenH: 1000 },
        state,
        1 / 60,
        params
      );
      state = r.smoothedPx;
    }
    ok(
      'a stationary camera decays smoothed motion to (near) zero, not a residual value',
      Math.abs(state.x) < 1e-3 && Math.abs(state.y) < 1e-3
    );
  }

  // ── computeZoomMotionBlurPx ────────────────────────────────────────────────
  ok('zero zoom velocity is zero blur', computeZoomMotionBlurPx(0, 1, 10) === 0);
  ok('clamped to maxPx', computeZoomMotionBlurPx(1000, 5, 10) === 10);
  ok('sign is preserved (in vs out reads differently downstream)', computeZoomMotionBlurPx(-5, 1, 10) < 0);

  // ── computeLightBurnDecayFactor ────────────────────────────────────────────
  ok(
    'decay is in (0, 1] for a real dt/persistence pair',
    (() => {
      const d = computeLightBurnDecayFactor(1 / 60, 0.5);
      return d > 0 && d <= 1;
    })()
  );
  ok(
    'a longer persistence decays SLOWER (closer to 1) for the same dt',
    computeLightBurnDecayFactor(1 / 60, 5) > computeLightBurnDecayFactor(1 / 60, 0.1)
  );
  ok(
    'halving-scale sanity: dt == persistence decays to 1/e, not some arbitrary constant',
    Math.abs(computeLightBurnDecayFactor(1, 1) - Math.exp(-1)) < 1e-9
  );

  // ── computeLightBurnDarknessGate ───────────────────────────────────────────
  ok(
    'disabled gate is always 1 (no suppression) regardless of darkness',
    computeLightBurnDarknessGate({ darkness01: 0, start: 0, end: 1, influence: 1, enabled: false }) === 1
  );
  ok(
    'fully dark (darkness=1) inside [0,1] range with full influence reads at full gate (1)',
    computeLightBurnDarknessGate({ darkness01: 1, start: 0, end: 1, influence: 1, enabled: true }) === 1
  );
  ok(
    'fully lit (darkness=0) inside [0,1] range with full influence reads at zero gate (fully suppressed)',
    computeLightBurnDarknessGate({ darkness01: 0, start: 0, end: 1, influence: 1, enabled: true }) === 0
  );
  ok(
    'zero influence never suppresses, regardless of darkness',
    computeLightBurnDarknessGate({ darkness01: 0, start: 0, end: 1, influence: 0, enabled: true }) === 1
  );
  ok(
    'start/end given in reverse order still resolves correctly (reads the real min/max)',
    computeLightBurnDarknessGate({ darkness01: 1, start: 1, end: 0, influence: 1, enabled: true }) === 1
  );
  ok(
    'a degenerate zero-width range does not throw or divide into NaN',
    Number.isFinite(
      computeLightBurnDarknessGate({ darkness01: 0.5, start: 0.5, end: 0.5, influence: 1, enabled: true })
    )
  );
}
