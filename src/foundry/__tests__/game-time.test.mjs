/**
 * THE GAME-TIME READER's pure core: folding Foundry's calendar onto MSA's 0..24
 * hour axis.
 *
 * The non-Earth-calendar assertions are the ones that matter. A world with a
 * 20-hour day has its midday at calendar hour 10, and if that maps to 10.0 on
 * our axis the sun rises mid-morning and nobody can say why. V2 got this right
 * (`legacy/core/foundry-time-phases.js`) and it is harvested here rather than
 * re-derived.
 */
import { deriveHourFromComponents, DEFAULT_CALENDAR_UNITS } from '../game-time.js';

export function run(t) {
  const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

  // ---- the Earth calendar ---------------------------------------------------
  {
    t.ok('midnight', close(deriveHourFromComponents({ hour: 0, minute: 0, second: 0 }), 0));
    t.ok('noon', close(deriveHourFromComponents({ hour: 12 }), 12));
    t.ok('minutes fold in', close(deriveHourFromComponents({ hour: 14, minute: 30 }), 14.5));
    t.ok('seconds fold in', close(deriveHourFromComponents({ hour: 6, minute: 0, second: 1800 }), 6.5));
    t.ok('absent minute/second default to 0, not NaN', close(deriveHourFromComponents({ hour: 9 }), 9));
  }

  // ---- a world that is not Earth --------------------------------------------
  {
    const twentyHourDay = { hoursPerDay: 20, minutesPerHour: 60, secondsPerMinute: 60 };
    t.ok(
      'a 20-hour day: its MIDDAY (hour 10) is noon on our axis',
      close(deriveHourFromComponents({ hour: 10 }, twentyHourDay), 12)
    );
    t.ok('a 20-hour day: hour 0 is still midnight', close(deriveHourFromComponents({ hour: 0 }, twentyHourDay), 0));
    t.ok(
      'a 20-hour day: its final hour lands just before midnight',
      close(deriveHourFromComponents({ hour: 19 }, twentyHourDay), 22.8)
    );

    const oddMinutes = { hoursPerDay: 24, minutesPerHour: 100, secondsPerMinute: 100 };
    t.ok(
      'a 100-minute hour: half past is still 12.5',
      close(deriveHourFromComponents({ hour: 12, minute: 50 }, oddMinutes), 12.5)
    );
  }

  // ---- wrapping and robustness ---------------------------------------------
  {
    t.ok('an hour past the day length wraps', close(deriveHourFromComponents({ hour: 26 }), 2));
    t.ok('a negative hour wraps forward', close(deriveHourFromComponents({ hour: -1 }), 23));
    t.ok('null components → null, never a guessed noon', deriveHourFromComponents(null) === null);
    t.ok('components with no hour → null', deriveHourFromComponents({ minute: 30 }) === null);
    t.ok('a non-numeric hour → null', deriveHourFromComponents({ hour: 'six' }) === null);
    t.ok('a non-object → null', deriveHourFromComponents(42) === null);
  }

  {
    // A zero/negative/absent calendar unit must fall back to Earth, never divide
    // by zero — a NaN hour would reach world/sun.js and read as noon forever,
    // which looks like a working scene and is not one.
    const broken = { hoursPerDay: 0, minutesPerHour: -5, secondsPerMinute: NaN };
    const h = deriveHourFromComponents({ hour: 6, minute: 30 }, broken);
    t.ok('a broken calendar falls back to Earth units', close(h, 6.5));
    t.ok('and never yields NaN', Number.isFinite(h));
    t.ok(
      'an absent units object uses the Earth defaults',
      close(
        deriveHourFromComponents({ hour: 3 }, undefined),
        deriveHourFromComponents({ hour: 3 }, DEFAULT_CALENDAR_UNITS)
      )
    );
  }
}
