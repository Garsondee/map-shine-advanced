/**
 * The env snapshot — the call sheet every pass reads. What is proven here:
 * it is FROZEN (nobody scribbles on it), time flows one way into it, and
 * darkness has exactly one derivation with the max(night, GM) authority rule.
 */
import { buildEnvSnapshot, DEFAULT_WEATHER, DEFAULT_WIND } from '../environment.js';

const time = (over = {}) => ({ frame: 1, tMs: 1000, dtSec: 0.016, ...over });

export function run(t) {
  // ---- shape + freezing ------------------------------------------------------
  {
    const env = buildEnvSnapshot({ time: time(), todHour: 12 });
    t.ok(
      'env carries time/sun/weather/wind/darkness',
      ['time', 'sun', 'weather', 'wind', 'darkness01'].every((k) => k in env)
    );
    t.ok('env is frozen', Object.isFrozen(env));
    t.ok(
      '...deeply (weather too)',
      Object.isFrozen(env.weather) && Object.isFrozen(env.sun) && Object.isFrozen(env.wind)
    );
    t.ok('defaults are clear windless noon', env.weather.preset === 'clear' && env.wind.speed01 === 0);
    t.ok('time.todHour rides the snapshot', env.time.todHour === 12);
  }

  // ---- time is upstream: sun follows todHour ---------------------------------
  {
    const noon = buildEnvSnapshot({ time: time(), todHour: 12 });
    const night = buildEnvSnapshot({ time: time(), todHour: 0 });
    t.ok('sun derives from the todHour handed in', noon.sun.aboveHorizon && !night.sun.aboveHorizon);
  }

  // ---- ONE darkness, max(night, GM) -------------------------------------------
  {
    const noonClear = buildEnvSnapshot({ time: time(), todHour: 12, darknessInput: 0 });
    t.ok('clear noon: darkness 0', noonClear.darkness01 === 0);

    const midnight = buildEnvSnapshot({ time: time(), todHour: 0, darknessInput: 0 });
    t.ok('midnight: night wins even when GM slider is 0', midnight.darkness01 === 1);

    const gmDarkNoon = buildEnvSnapshot({ time: time(), todHour: 12, darknessInput: 0.8 });
    t.ok('GM darkening at noon wins over the daylight', gmDarkNoon.darkness01 === 0.8);

    const both = buildEnvSnapshot({ time: time(), todHour: 0, darknessInput: 0.3 });
    t.ok('the darker authority wins (max, never dilution)', both.darkness01 === 1);
  }

  // ---- input hygiene: clamped, normalised, loud on programmer error -----------
  {
    const env = buildEnvSnapshot({
      time: time(),
      todHour: 26.5, // wraps to 2.5
      weather: { precip01: 7, cloudCover01: -3, wetness01: NaN },
      wind: { directionDeg: -90, speed01: 2 },
    });
    t.ok('todHour normalised', env.time.todHour === 2.5);
    t.ok('weather clamped to 0..1', env.weather.precip01 === 1 && env.weather.cloudCover01 === 0);
    t.ok('NaN clamps to 0, never propagates', env.weather.wetness01 === 0);
    t.ok('wind direction wraps to 0..360', env.wind.directionDeg === 270);
    t.ok('wind speed clamps', env.wind.speed01 === 1);

    t.throws(
      'a missing clock is a LOUD error (not a silent default)',
      () => buildEnvSnapshot({ todHour: 12 }),
      'frame-clock'
    );
  }

  // ---- determinism: same inputs, same sheet -----------------------------------
  {
    const a = buildEnvSnapshot({ time: time(), todHour: 9.25, weather: { preset: 'rain', precip01: 0.5 } });
    const b = buildEnvSnapshot({ time: time(), todHour: 9.25, weather: { preset: 'rain', precip01: 0.5 } });
    t.ok('pure: identical inputs produce identical snapshots', JSON.stringify(a) === JSON.stringify(b));
  }

  // the exported defaults are themselves frozen vocabulary
  t.ok('DEFAULT_WEATHER frozen', Object.isFrozen(DEFAULT_WEATHER));
  t.ok('DEFAULT_WIND frozen', Object.isFrozen(DEFAULT_WIND));
}
