/**
 * The env snapshot — the call sheet every pass reads. What is proven here:
 * it is FROZEN (nobody scribbles on it), time flows one way into it, and
 * darkness has exactly one derivation with the max(night, GM) authority rule.
 */
import { buildEnvSnapshot, DEFAULT_WEATHER, DEFAULT_WIND, DEFAULT_AMBIENT } from '../environment.js';

const time = (over = {}) => ({ frame: 1, tMs: 1000, dtSec: 0.016, ...over });

export function run(t) {
  // ---- shape + freezing ------------------------------------------------------
  {
    const env = buildEnvSnapshot({ time: time(), todHour: 12 });
    t.ok(
      'env carries time/sun/weather/wind/darkness/ambient',
      ['time', 'sun', 'weather', 'wind', 'darkness01', 'ambient'].every((k) => k in env)
    );
    t.ok('env is frozen', Object.isFrozen(env));
    t.ok(
      '...deeply (weather + ambient too)',
      Object.isFrozen(env.weather) &&
        Object.isFrozen(env.sun) &&
        Object.isFrozen(env.wind) &&
        Object.isFrozen(env.ambient)
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

  // ---- ambient palette: passed through, defaulted, and clamped ---------------
  {
    const noAmb = buildEnvSnapshot({ time: time(), todHour: 12 });
    t.ok(
      'no ambient input => DEFAULT_AMBIENT endpoints',
      noAmb.ambient.daylight[0] === DEFAULT_AMBIENT.daylight[0] &&
        noAmb.ambient.darkness[2] === DEFAULT_AMBIENT.darkness[2]
    );

    const amb = buildEnvSnapshot({
      time: time(),
      todHour: 12,
      ambientInput: { daylight: [0.8, 0.7, 0.6], darkness: [0.1, 0.1, 0.2], brightest: [1, 1, 1] },
    });
    t.ok('ambient endpoints pass through', amb.ambient.daylight[1] === 0.7 && amb.ambient.darkness[0] === 0.1);

    const clamped = buildEnvSnapshot({
      time: time(),
      todHour: 12,
      ambientInput: { daylight: [2, -1, 0.5], darkness: [0.1, 0.1, 0.2], brightest: [1, 1, 1] },
    });
    t.ok(
      'out-of-range ambient channels clamp to [0,1]',
      clamped.ambient.daylight[0] === 1 && clamped.ambient.daylight[1] === 0
    );

    const malformed = buildEnvSnapshot({ time: time(), todHour: 12, ambientInput: { daylight: [1], darkness: null } });
    t.ok(
      'a malformed endpoint falls back to DEFAULT_AMBIENT, never NaN into a uniform',
      malformed.ambient.daylight[0] === DEFAULT_AMBIENT.daylight[0] &&
        malformed.ambient.darkness[0] === DEFAULT_AMBIENT.darkness[0]
    );
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

  // ---- THE WEATHER AXES + THE OWNER CONTRACT (manager slice 1) ----------------
  {
    const bare = buildEnvSnapshot({ time: time(), todHour: 12 });
    t.ok(
      'the cloud axes ride the call sheet',
      ['cloudType01', 'cloudAltitudePx', 'cloudScalePx'].every((k) => k in bare.weather)
    );
    t.ok(
      'no weather argument => hasOwner false: NOBODY WROTE THIS',
      bare.weather.hasOwner === false && bare.weather.ownerVersion === 0
    );
    t.ok(
      'a caller passing weather but not the flag is still ownerless (the flag is opt-IN)',
      buildEnvSnapshot({ time: time(), todHour: 12, weather: { cloudCover01: 0.5 } }).weather.hasOwner === false
    );
    t.ok(
      'an owner declaring itself is carried through with its version',
      buildEnvSnapshot({
        time: time(),
        todHour: 12,
        weather: { hasOwner: true, ownerVersion: 7 },
      }).weather.hasOwner === true
    );

    // ⚠️ Altitude/scale are LENGTHS. A bad value must not become 0 — that would
    // make the cloud shadow's `h / tan(elevation)` offset degenerate rather than
    // merely wrong (`feedback_derived_zero_collides_with_configured_zero`).
    const junk = buildEnvSnapshot({
      time: time(),
      todHour: 12,
      weather: { cloudAltitudePx: 0, cloudScalePx: NaN, cloudType01: 5 },
    });
    t.ok(
      'a zero altitude falls back, never lands as 0',
      junk.weather.cloudAltitudePx === DEFAULT_WEATHER.cloudAltitudePx
    );
    t.ok('a NaN scale falls back too', junk.weather.cloudScalePx === DEFAULT_WEATHER.cloudScalePx);
    t.ok('cloudType01 still clamps to 0..1 like any unit axis', junk.weather.cloudType01 === 1);
    t.ok(
      'a real positive length passes straight through',
      buildEnvSnapshot({ time: time(), todHour: 12, weather: { cloudAltitudePx: 2800 } }).weather.cloudAltitudePx ===
        2800
    );
  }

  // the exported defaults are themselves frozen vocabulary
  t.ok('DEFAULT_WEATHER frozen', Object.isFrozen(DEFAULT_WEATHER));
  t.ok('DEFAULT_WIND frozen', Object.isFrozen(DEFAULT_WIND));
  t.ok('DEFAULT_AMBIENT frozen', Object.isFrozen(DEFAULT_AMBIENT) && Object.isFrozen(DEFAULT_AMBIENT.daylight));
}
