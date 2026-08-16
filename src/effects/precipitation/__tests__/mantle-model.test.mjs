/**
 * THE MANTLE's arithmetic, proven before a texel is written
 * (docs/planning/Precipitation.md §5).
 *
 * ⚠️ THIS SUITE MATTERS MORE THAN MOST, and the reason is the subject: a mantle
 * bug takes GAME HOURS to become visible, so it is the one part of
 * precipitation nobody can iterate on by looking. The shader lab can prove the
 * buffer integrates; only Node can prove it integrates the RIGHT WAY.
 *
 * What is proven here:
 *   - a PAUSED game freezes the mantle (the integrator pattern, not a throttle);
 *   - snow accumulates only for a species that FEEDS the snow channel;
 *   - melt is exactly zero while it is still cold enough to be snowing —
 *     otherwise a blizzard fights itself to a standstill;
 *   - fire out-melts the heaviest snowfall, so a hearth holds its ground;
 *   - puddles always dry eventually, even cold and overcast;
 *   - the §5.5 seed lands where a scene that had really been running would be.
 */
import { PRECIP_SPECIES } from '../precip-species.js';
import {
  MANTLE_CHANNELS,
  resolveMantleStep,
  meltPerHour,
  dryPerHour,
  seedMantleDepth,
  gameHourDelta,
  SNOW_RATE_PER_HOUR,
} from '../mantle-model.js';
import { PRECIP_SLEET_BAND } from '../../../world/index.js';

export function run(t) {
  const snowStay = PRECIP_SPECIES.snow.stay;
  const rainStay = PRECIP_SPECIES.rain.stay;
  const cold = 0.1;
  const warm = 0.9;

  // ---- the channel map -------------------------------------------------------
  {
    t.ok('four channels, one byte each', Object.keys(MANTLE_CHANNELS).length === 4);
    t.ok('every channel maps to a distinct RGBA component', new Set(Object.values(MANTLE_CHANNELS)).size === 4);
    // ⚠️ ONE BYTE, ONE QUANTITY — the names carry the unit so a future reader
    // cannot repurpose a spare channel for a second meaning.
    t.ok(
      'every channel name states its 0..1 unit',
      Object.keys(MANTLE_CHANNELS).every((k) => k.endsWith('01'))
    );
  }

  // ---- ⭐ THE WRAPPING CLOCK --------------------------------------------------
  {
    // ⚠️ THIS BLOCK EXISTS BECAUSE ITS ABSENCE COST A WHOLE DEBUG CYCLE. The
    // helper was written precisely because a 0..24 clock's wrap is subtle — and
    // then it was not tested, so a `+ 36` where `+ 24` belonged shifted every
    // delta by half a day and returned ZERO for every ordinary tick. The mantle
    // integrated nothing while every rate beside it was correct and every
    // assertion in this file passed. A helper extracted for being tricky is
    // exactly the one that must be pinned.
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    t.ok('an ordinary forward tick is its own size', near(gameHourDelta(3.8, 4.0), 0.2));
    t.ok('a large forward step is its own size', near(gameHourDelta(1, 9), 8));
    // The case the helper exists for: 23.9 → 0.1 is a TENTH of an hour, not −23.8.
    t.ok('crossing midnight is a small delta, not a huge negative', near(gameHourDelta(23.9, 0.1), 0.2));
    t.ok('crossing midnight the long way round is still small', near(gameHourDelta(23.0, 1.0), 2));
    // Foundry's clock may run BACKWARDS (`rateHoursPerMinute` is legal −60..60),
    // and a rewind must not un-melt snow — nor be mistaken for a 24-hour leap.
    t.ok('a small rewind integrates nothing', gameHourDelta(4.0, 3.8) === 0);
    t.ok('a rewind across midnight integrates nothing', gameHourDelta(0.1, 23.9) === 0);
    t.ok('a standing clock integrates nothing', gameHourDelta(7, 7) === 0);
    t.ok('the first call after a seed integrates nothing', gameHourDelta(null, 12) === 0);
    t.ok('a non-finite reading integrates nothing', gameHourDelta(NaN, 5) === 0 && gameHourDelta(5, NaN) === 0);
    // Never negative, at any pair of hours — the mantle integrates forward only.
    const hours = [0, 0.1, 5.5, 11.9, 12, 12.1, 18, 23.9];
    t.ok(
      'no pair of clock readings ever yields a negative delta',
      hours.every((a) => hours.every((b) => gameHourDelta(a, b) >= 0))
    );
    t.ok(
      'no delta ever exceeds half a day',
      hours.every((a) => hours.every((b) => gameHourDelta(a, b) <= 12))
    );
  }

  // ---- ⭐ A PAUSED GAME FREEZES THE MANTLE -----------------------------------
  {
    const paused = resolveMantleStep({ stay: snowStay, precip01: 1, temperature01: cold, dtGameHours: 0 });
    t.ok('a paused game integrates zero game hours', paused.dtGameHours === 0);
    // ⚠️ THE RATES ARE STILL LIVE — this is the integrator pattern, not a
    // throttle. A throttle would suppress the RATE and then never fire again
    // once the clock stopped (`feedback_throttle_on_sim_clock_latches_when_paused`);
    // an integrator keeps the rate honest and multiplies by a zero delta.
    t.ok('…but the rates themselves are unchanged, not suppressed', paused.snowGainPerHour > 0);
    const running = resolveMantleStep({ stay: snowStay, precip01: 1, temperature01: cold, dtGameHours: 0.5 });
    t.ok('a running game integrates a real delta', running.dtGameHours === 0.5);
    t.ok('the rate does not depend on the delta', Math.abs(running.snowGainPerHour - paused.snowGainPerHour) < 1e-12);
  }

  // ---- the delta is clamped at BOTH ends --------------------------------------
  {
    const back = resolveMantleStep({ stay: snowStay, precip01: 1, temperature01: cold, dtGameHours: -5 });
    t.ok('time does not run backwards', back.dtGameHours === 0);
    // A scene resumed after hours away, or a GM spinning the clock, must not
    // deposit a whole winter in one step.
    const jump = resolveMantleStep({ stay: snowStay, precip01: 1, temperature01: cold, dtGameHours: 400 });
    t.ok('a clock jump is capped at one game hour per step', jump.dtGameHours === 1);
    const nan = resolveMantleStep({ stay: snowStay, precip01: 1, temperature01: cold, dtGameHours: NaN });
    t.ok('a non-finite delta integrates nothing rather than NaN', nan.dtGameHours === 0);
  }

  // ---- only the species that FEEDS a channel fills it -------------------------
  {
    const snowing = resolveMantleStep({ stay: snowStay, precip01: 1, temperature01: cold, dtGameHours: 1 });
    const raining = resolveMantleStep({ stay: rainStay, precip01: 1, temperature01: warm, dtGameHours: 1 });
    t.ok('snow deposits snow', snowing.snowGainPerHour > 0);
    // ⚠️ RAIN MUST NOT THICKEN THE DRIFTS IT IS WASHING AWAY. `channel: null`
    // is a real answer, and this is the assertion that keeps it one.
    t.ok('rain deposits NO snow', raining.snowGainPerHour === 0);
    t.ok('rain fills puddles', raining.puddleGainPerHour > 0);
    t.ok('snow fills no puddles while it is snow', snowing.puddleGainPerHour === 0);
    t.ok('neither species deposits dust (that is P6)', snowing.dustGainPerHour === 0 && raining.dustGainPerHour === 0);
    const clear = resolveMantleStep({ stay: null, precip01: 0, temperature01: warm, dtGameHours: 1 });
    // A clear day still RUNS the integrator — melt and drying continue — but
    // deposits nothing. `stay: null` is the common case, not an error case.
    t.ok('a clear sky deposits nothing', clear.snowGainPerHour === 0 && clear.puddleGainPerHour === 0);
    t.ok('…but still melts and dries', clear.meltPerHour > 0 && clear.dryPerHour > 0);
  }

  // ---- ⭐ MELT IS ZERO WHILE IT IS STILL COLD ENOUGH TO SNOW ------------------
  {
    // Otherwise a blizzard fights itself to a standstill at some middling depth
    // and the ground never whitens.
    t.ok('no melt below the sleet band', meltPerHour(0) === 0 && meltPerHour(PRECIP_SLEET_BAND.coldEdge) === 0);
    t.ok('no melt AT the warm edge (closed, not half-open)', meltPerHour(PRECIP_SLEET_BAND.warmEdge) === 0);
    t.ok('melt begins just above the band', meltPerHour(PRECIP_SLEET_BAND.warmEdge + 0.02) > 0);
    t.ok(
      'melt rises monotonically',
      [0.35, 0.5, 0.65, 0.8, 1].every((v, i, a) => i === 0 || meltPerHour(v) >= meltPerHour(a[i - 1]))
    );
    t.ok('melt saturates rather than growing without bound', meltPerHour(1) === meltPerHour(0.9));
    // ⚠️ THE BAND IS SHARED WITH `derivePrecipKind`, NOT RESTATED. Two copies of
    // "what counts as freezing" is how a map ends up falling snow that instantly
    // melts (`feedback_shared_field_two_meanings_two_registries`).
    t.ok(
      'the melt threshold IS the sky’s own snow/rain boundary',
      meltPerHour(PRECIP_SLEET_BAND.warmEdge) === 0 && meltPerHour(PRECIP_SLEET_BAND.warmEdge + 1e-3) > 0
    );
  }

  // ---- ⭐ A HEARTH HOLDS ITS GROUND IN A BLIZZARD ----------------------------
  {
    const blizzard = resolveMantleStep({ stay: snowStay, precip01: 1, temperature01: 0, dtGameHours: 1 });
    // Fire melt must OUT-RUN the heaviest deposit, not merely subtract from it —
    // otherwise the halo is a slightly-thinner patch nobody reads as heat.
    t.ok('fire melt out-runs the heaviest snowfall', blizzard.fireMeltPerHour > blizzard.snowGainPerHour * 2);
    t.ok(
      'the heaviest snowfall is the row’s own rate',
      Math.abs(blizzard.snowGainPerHour - SNOW_RATE_PER_HOUR) < 1e-12
    );
    // ⚠️ AMBIENT MELT MUST ALSO OUT-RUN THE HEAVIEST DEPOSIT, and the first
    // value did not (0.68 vs 0.8/hour), which left the equilibrium depth above
    // 1 — so "warm" and "freezing" seeded the identical saturated drift and the
    // temperature axis meant nothing spatially. A broken STATE, not a tuning
    // miss, so it is pinned here rather than left to arithmetic nobody rechecks.
    const hot = resolveMantleStep({ stay: snowStay, precip01: 1, temperature01: 1, dtGameHours: 1 });
    t.ok('full warmth out-melts the heaviest snowfall', hot.meltPerHour > hot.snowGainPerHour);
  }

  // ---- puddles always dry, and the sun dries them faster ----------------------
  {
    t.ok('hot and clear dries fastest', dryPerHour(1, 0) > dryPerHour(1, 1));
    t.ok('warm dries faster than cold', dryPerHour(0.9, 0.5) > dryPerHour(0.1, 0.5));
    // ⚠️ NEVER ZERO. A puddle that literally cannot dry is a permanent scar on
    // a map — "it rained here once, three months ago" is not a feature.
    t.ok('the coldest, wettest sky still drains', dryPerHour(0, 1) > 0);
    t.ok('drying is bounded', dryPerHour(1, 0) < 1);
  }

  // ---- ⭐ §5.5 SEEDING lands where a running scene would be -------------------
  {
    const seededCold = seedMantleDepth({ stay: snowStay, precip01: 0.9, temperature01: cold, hoursOfWeather: 2 });
    t.ok('a cold snowy sky seeds real snow', seededCold.snow01 > 0.3);
    t.ok('…and no puddles', seededCold.puddle01 === 0);

    const seededWarm = seedMantleDepth({ stay: snowStay, precip01: 0.9, temperature01: warm, hoursOfWeather: 6 });
    // Warm enough to melt as fast as it falls ⇒ the equilibrium is shallow.
    t.ok('a warm sky cannot seed a deep drift', seededWarm.snow01 < seededCold.snow01);

    const seededRain = seedMantleDepth({ stay: rainStay, precip01: 0.8, temperature01: 0.6, hoursOfWeather: 3 });
    t.ok('rain seeds puddles, not snow', seededRain.puddle01 > 0 && seededRain.snow01 === 0);

    const seededClear = seedMantleDepth({ stay: null, precip01: 0, temperature01: 0.5, hoursOfWeather: 12 });
    t.ok('a clear sky seeds an empty mantle', seededClear.snow01 === 0 && seededClear.puddle01 === 0);

    // ⚠️ THE `loss = 0` BRANCH IS THE PHYSICALLY COMMON CASE, not defensive
    // padding: snow below freezing has NO ambient sink at all, so the closed
    // form would divide by zero. Deep freeze + long weather must still cap at 1.
    const deepFreeze = seedMantleDepth({ stay: snowStay, precip01: 1, temperature01: 0, hoursOfWeather: 500 });
    t.ok('an eternal blizzard saturates at 1, it does not overflow', deepFreeze.snow01 === 1);

    // Longer weather accumulates more, up to the equilibrium.
    const short = seedMantleDepth({ stay: rainStay, precip01: 0.6, temperature01: 0.7, hoursOfWeather: 0.5 });
    const long = seedMantleDepth({ stay: rainStay, precip01: 0.6, temperature01: 0.7, hoursOfWeather: 8 });
    t.ok('longer weather seeds deeper, up to equilibrium', long.puddle01 > short.puddle01);
    t.ok(
      'every seeded depth is a real 0..1',
      [short, long, seededCold, seededWarm].every((d) => Object.values(d).every((v) => v >= 0 && v <= 1))
    );
  }

  // ---- the species rows carry a well-formed `stay` ----------------------------
  {
    for (const id of ['rain', 'snow']) {
      const s = PRECIP_SPECIES[id].stay;
      t.ok(
        `${id}: stay names a channel or explicitly null`,
        s.channel === null || s.channel === 'snow' || s.channel === 'dust'
      );
      t.ok(`${id}: rates are finite and non-negative`, s.ratePerHour >= 0 && s.puddleRatePerHour >= 0);
      t.ok(
        `${id}: declares both melt sinks`,
        typeof s.meltBy.temperature === 'boolean' && typeof s.meltBy.fire === 'boolean'
      );
      t.ok(
        `${id}: surface tint is a linear RGB triple`,
        s.surface.tint.length === 3 && s.surface.tint.every((c) => c >= 0 && c <= 1)
      );
    }
    // ⚠️ OPPOSITE SIGNS, AND THAT IS WHY THEY ARE TWO CHANNELS WITH TWO BLEND
    // OPS. Fresh snow is ROUGHER than the stone; wet stone is SMOOTHER. One
    // "cover" value could not carry both (`feedback_blend_neutral_element_is_per_blend`).
    t.ok(
      'snow roughens while water smooths',
      PRECIP_SPECIES.snow.stay.surface.roughnessDelta > 0 && PRECIP_SPECIES.rain.stay.surface.roughnessDelta < 0
    );
    t.ok(
      'only snow sparkles',
      PRECIP_SPECIES.snow.stay.surface.sparkle01 > 0 && PRECIP_SPECIES.rain.stay.surface.sparkle01 === 0
    );
  }
}
