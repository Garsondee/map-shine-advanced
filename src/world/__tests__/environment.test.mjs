/**
 * The env snapshot — the call sheet every pass reads. What is proven here:
 * it is FROZEN (nobody scribbles on it), time flows one way into it, and
 * darkness has exactly one derivation with the max(night, GM) authority rule.
 */
import {
  buildEnvSnapshot,
  DEFAULT_WEATHER,
  DEFAULT_WIND,
  DEFAULT_AMBIENT,
  SIGHT_DARKNESS_THRESHOLD,
  FULL_MOON_DARKNESS_CAP,
  moonDarknessCap,
  undergroundDarkness,
  indoorShareOfOutdoorsGrid,
} from '../environment.js';
import { WEATHER_AXIS_NAMES, createWeatherManager } from '../weather.js';

const time = (over = {}) => ({ frame: 1, tMs: 1000, dtSec: 0.016, ...over });

export function run(t) {
  // ---- ⭐ THE SEAM GUARD: every axis the manager owns must SURVIVE the snapshot
  //
  // This exists because the snapshot's weather block is a hand-maintained
  // allow-list and it forgot once, in a way no other test could see. `precip01`
  // and `temperature01` were added to `WEATHER_AXES`, the manager derived
  // `precipKind` correctly, every manager test passed — and the snapshot
  // silently dropped all three, so clicking the astrolabe's SNOW button
  // produced rain on a live map for two commits
  // (`feedback_hand_maintained_dispatch_list_forgets_new_effects`).
  //
  // Asserting against `WEATHER_AXIS_NAMES` rather than a second hardcoded list
  // is the whole point: the next axis added without wiring fails HERE.
  {
    const mgr = createWeatherManager();
    mgr.jumpTo({ precip01: 0.5, temperature01: 0.1 });
    const env = buildEnvSnapshot({ time: time(), todHour: 12, weather: mgr.toSnapshotWeather() });
    const missing = WEATHER_AXIS_NAMES.filter((n) => env.weather[n] === undefined);
    t.ok(
      `⭐ every WEATHER_AXES axis reaches env.weather (missing: ${missing.join(',') || 'none'})`,
      missing.length === 0
    );
    t.ok('...and their VALUES survive rather than being defaulted away', env.weather.precip01 === 0.5);
    // The derived fields are not axes, so name them explicitly — they are the
    // ones a consumer actually branches on.
    t.ok('the DERIVED precipKind survives the seam', env.weather.precipKind === 'snow');
    t.ok('...as does its mix weight', Number.isFinite(env.weather.precipMixWeight));
    t.ok('...and the authored kind, for diagnostics', typeof env.weather.precipKindAuthored === 'string');
    // Fail-open: an un-owned snapshot must still name a kind rather than
    // handing a consumer `undefined` to fall back from.
    const unowned = buildEnvSnapshot({ time: time(), todHour: 12 });
    t.ok('an unowned snapshot still names a precipKind', typeof unowned.weather.precipKind === 'string');
    t.ok('...and is dry', unowned.weather.precip01 === 0);
  }

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

    // MSA OWNS DARKNESS (mmp-bsp, Ingram 2026-11-11): "Outside at noon should be darkness 0 (we should force this)".
    const gmDarkNoon = buildEnvSnapshot({ time: time(), todHour: 12, darknessInput: 0.8, indoorShare01: 0 });
    t.ok(
      'noon is forced to darkness 0 on a floor with an outdoors mask, even with an authored 0.8',
      gmDarkNoon.darkness01 === 0
    );
    const basement = buildEnvSnapshot({ time: time(), todHour: 12, darknessInput: 1, indoorShare01: null });
    t.ok('a floor with NO outdoors mask (a basement) still honours the authored darkness', basement.darkness01 === 1);
    t.ok('…the authored value is still reported', gmDarkNoon.darknessParts.authoredDarkness01 === 0.8);

    const both = buildEnvSnapshot({ time: time(), todHour: 0, darknessInput: 0.3 });
    t.ok('midnight with no moon reaches full darkness', both.darkness01 === 1);
  }

  // ---- moonlight caps the exterior; underground floors are dark ------------
  {
    const fullMoon = buildEnvSnapshot({ time: time(), todHour: 0, moonlight01: 1 });
    t.ok(
      'full moon: midnight exterior stays just under the sight threshold (tokens see full distance)',
      fullMoon.darkness01 === FULL_MOON_DARKNESS_CAP && fullMoon.darkness01 < SIGHT_DARKNESS_THRESHOLD
    );
    const halfMoon = buildEnvSnapshot({ time: time(), todHour: 0, moonlight01: 0.5 });
    t.ok(
      'half moon: a darker night, above the sight threshold, below full dark',
      halfMoon.darkness01 > SIGHT_DARKNESS_THRESHOLD && halfMoon.darkness01 < 1
    );
    t.ok('moon cap is a straight gradient', moonDarknessCap(0) === 1 && moonDarknessCap(1) === FULL_MOON_DARKNESS_CAP);
    const cave = buildEnvSnapshot({ time: time(), todHour: 12, moonlight01: 1, indoorShare01: 0.95 });
    t.ok('a floor 95% indoors is underground: full dark even at noon', cave.darkness01 === 1);
    const house = buildEnvSnapshot({ time: time(), todHour: 12, indoorShare01: 0.3 });
    t.ok('a mostly outdoor floor at noon stays at 0', house.darkness01 === 0);
    t.ok(
      'underground eases in between 60% and 90% indoors',
      undergroundDarkness(0.6) === 0 &&
        undergroundDarkness(0.75) > 0 &&
        undergroundDarkness(0.75) < 1 &&
        undergroundDarkness(0.9) === 1
    );
    t.ok(
      'indoor share is the black fraction of the _Outdoors grid',
      indoorShareOfOutdoorsGrid({ data: new Uint8Array([0, 0, 0, 255]) }) === 0.75 &&
        indoorShareOfOutdoorsGrid(null) === null
    );
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
