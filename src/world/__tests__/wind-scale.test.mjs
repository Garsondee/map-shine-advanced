/**
 * wind-scale.test.mjs — the Beaufort mapping that gives the wind dial a real
 * reading (mythica-machina-press#497 Stage 1 / #498).
 *
 * ⚠️ THE ASSERTIONS ARE AGAINST THE REAL SCALE, not against this module's own
 * arithmetic. `v = 0.836·B^1.5` is checked by confirming each force lands
 * INSIDE its real published speed band — which is a claim about the world that
 * a refactor cannot quietly redefine, unlike "the function returns what the
 * function computes".
 */
import {
  BEAUFORT_SCALE,
  BEAUFORT_MAX,
  beaufortForSpeed01,
  speed01ForBeaufort,
  metresPerSecondForSpeed01,
  speed01ForMetresPerSecond,
  beaufortRowForMetresPerSecond,
  describeWindSpeed01,
} from '../wind-scale.js';

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

export function run(t) {
  const { ok } = t;

  // ---- ⭐ DIAL 0 IS EXACTLY ZERO --------------------------------------------
  // Stage 1's whole point. A scale with any floor in it would quietly
  // reintroduce what `WIND_INDOOR_RESIDUAL` was deleted for.
  {
    ok('⭐ speed01 0 is exactly 0 m/s, not nearly', metresPerSecondForSpeed01(0) === 0);
    ok('...and exactly Beaufort 0', beaufortForSpeed01(0) === 0);
    ok('a negative dial clamps to 0 rather than blowing backwards', metresPerSecondForSpeed01(-1) === 0);
    ok('a non-finite dial reads 0, never NaN', metresPerSecondForSpeed01(NaN) === 0);
  }

  // ---- ⭐ EACH FORCE LANDS INSIDE ITS REAL PUBLISHED BAND --------------------
  {
    let allInBand = true;
    for (let force = 1; force < BEAUFORT_MAX; force++) {
      const v = metresPerSecondForSpeed01(speed01ForBeaufort(force));
      const lower = BEAUFORT_SCALE[force].minMetresPerSecond;
      const upper = BEAUFORT_SCALE[force + 1].minMetresPerSecond;
      if (!(v >= lower && v < upper)) allInBand = false;
    }
    ok('⭐ every force 1-11 converts to a speed inside its own real band', allInBand);
    ok(
      'force 12 clears the real hurricane threshold (32.7 m/s)',
      metresPerSecondForSpeed01(1) >= BEAUFORT_SCALE[12].minMetresPerSecond
    );
    ok('the top of the dial is force 12, not 13', approx(beaufortForSpeed01(1), 12));
  }

  // ---- the seven checkpoints the epic is specified against -------------------
  // These are the dial positions #497 §5 writes its acceptance criteria for, so
  // a change that silently moved the scale under them would break the spec
  // rather than just a number.
  {
    const at = (dial) => describeWindSpeed01(dial / 100);
    ok('dial 0 is Calm', at(0).force === 0 && at(0).name === 'Calm');
    ok('dial 15 is a Light breeze (~2 m/s)', at(15).force === 2 && approx(at(15).metresPerSecond, 2.019, 0.01));
    ok('dial 35 is a Moderate breeze (~7.2 m/s)', at(35).force === 4 && approx(at(35).metresPerSecond, 7.196, 0.01));
    ok('dial 50 is a Strong breeze (~12.3 m/s)', at(50).force === 6 && approx(at(50).metresPerSecond, 12.287, 0.01));
    ok('dial 75 is a Strong gale (~22.6 m/s)', at(75).force === 9 && approx(at(75).metresPerSecond, 22.572, 0.01));
    ok('dial 100 is a Hurricane (~34.8 m/s)', at(100).force === 12 && approx(at(100).metresPerSecond, 34.752, 0.01));
    // ⭐ The land criterion is the checkable half — "is the wind right at 35?"
    // becomes "is dust lifting and are small branches moving?" rather than a
    // matter of taste.
    ok('dial 35 carries its real land criterion', at(35).land.includes('dust'));
    ok('dial 100 carries its real land criterion', at(100).land === 'Devastation');
  }

  // ---- the scale is ordered and reversible ----------------------------------
  {
    let monotonic = true;
    let prev = -1;
    for (let d = 0; d <= 100; d++) {
      const v = metresPerSecondForSpeed01(d / 100);
      if (v < prev) monotonic = false;
      prev = v;
    }
    ok('speed rises monotonically across the whole dial', monotonic);

    let roundTrips = true;
    for (const d of [0, 0.05, 0.15, 0.35, 0.5, 0.75, 1]) {
      const back = speed01ForMetresPerSecond(metresPerSecondForSpeed01(d));
      if (!approx(back, d, 1e-9)) roundTrips = false;
    }
    ok('speed01 -> m/s -> speed01 round-trips', roundTrips);
  }

  // ---- the band lookup ------------------------------------------------------
  {
    ok('0 m/s is Calm', beaufortRowForMetresPerSecond(0).force === 0);
    ok('12 m/s is a Strong breeze', beaufortRowForMetresPerSecond(12).force === 6);
    ok('40 m/s is still Hurricane (the scale has no 13)', beaufortRowForMetresPerSecond(40).force === 12);
    ok('a non-finite speed reads as Calm rather than throwing', beaufortRowForMetresPerSecond(NaN).force === 0);
  }
}
