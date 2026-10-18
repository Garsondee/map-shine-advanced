/**
 * Weather acts on insects in two ways — it thins the head-count, and it changes how the ones that stay
 * move — and both are pure functions of the frame's env snapshot and an effect's own params. They are
 * driven here with REAL snapshots from `world/environment.js` (the builder the frame loop uses), so the
 * kinds, thresholds and units are the sky's own, not numbers a test author typed in and believed.
 */
import { buildEnvSnapshot } from '../../../world/environment.js';
import {
  LOAD_SATURATION,
  skyFeel,
  weatherFactor,
  weatherDrive,
  CALM_DRIVE,
  WEATHER_FACTOR_PARAMS,
  WEATHER_DRIVE_PARAMS,
} from '../critter-weather.js';

const sky = ({ weather = {}, wind = {} } = {}) =>
  buildEnvSnapshot({ time: { frame: 1, tMs: 1000, dtSec: 0.016 }, todHour: 12, weather, wind });
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

export function run(t) {
  // ---- the sky as an insect feels it ----------------------------------------------------------------
  const calm = skyFeel(sky());
  t.ok(
    'a clear, windless sky is felt as nothing',
    calm.rainLoad === 0 && calm.snowLoad === 0 && calm.wind === 0 && calm.windEffective === 0
  );
  t.ok('…and as mild, well clear of any cold response', calm.temperature > 0.5);
  t.ok(
    'no snapshot at all (the first frame) reads as calm and mild, never as a storm',
    skyFeel(null).rainLoad === 0 && skyFeel(null).windEffective === 0 && skyFeel(null).temperature > 0.5
  );

  t.ok(
    `rain saturates at ${LOAD_SATURATION}: steady, soaking rain is a FULL load, not only precipitation 1`,
    near(skyFeel(sky({ weather: { precip01: LOAD_SATURATION, precipKind: 'rain' } })).rainLoad, 1) &&
      near(skyFeel(sky({ weather: { precip01: LOAD_SATURATION / 2, precipKind: 'rain' } })).rainLoad, 0.5) &&
      skyFeel(sky({ weather: { precip01: 1, precipKind: 'rain' } })).rainLoad === 1
  );
  const snowing = skyFeel(sky({ weather: { precip01: 0.7, precipKind: 'snow', temperature01: 0.1 } }));
  t.ok('snow is a snow load and no rain load', snowing.snowLoad === 1 && snowing.rainLoad === 0);
  const sleet = skyFeel(sky({ weather: { precip01: 0.7, precipKind: 'sleet', precipMixWeight: 0.25 } }));
  t.ok(
    'sleet splits into both, by the mix weight the weather manager derived',
    near(sleet.snowLoad, 0.25) && near(sleet.rainLoad, 0.75)
  );
  t.ok('hail soaks like rain', skyFeel(sky({ weather: { precip01: 0.7, precipKind: 'hail' } })).rainLoad === 1);
  t.ok(
    'falling ash is a lighter, rain-like irritant',
    near(skyFeel(sky({ weather: { precip01: 0.7, precipKind: 'ash' } })).rainLoad, 0.6)
  );
  t.ok(
    'an unknown kind is rain (the pessimistic answer for a bug)',
    skyFeel({ weather: { precip01: 0.7, precipKind: 'meteors' }, wind: {} }).rainLoad === 1
  );
  t.ok(
    'a gust adds to the felt wind (a gusty half gale reads as ~0.75), never past a gale',
    near(skyFeel(sky({ wind: { speed01: 0.5, gustiness01: 1 } })).windEffective, 0.75) &&
      skyFeel(sky({ wind: { speed01: 1, gustiness01: 1 } })).windEffective === 1
  );

  // ---- the head-count -----------------------------------------------------------------------------
  const storm = skyFeel(sky({ weather: { precip01: 1, precipKind: 'rain', temperature01: 0 }, wind: { speed01: 1 } }));
  t.ok('an effect with no responses declared is indifferent to everything', weatherFactor(storm, {}) === 1);
  t.ok('…and so is one whose responses are all 0', weatherFactor(storm, { rainResponse: 0, windResponse: 0 }) === 1);

  const rain = (precip) => skyFeel(sky({ weather: { precip01: precip, precipKind: 'rain' } }));
  t.ok('rain response 1 clears the air in a full downpour', weatherFactor(rain(0.7), { rainResponse: 1 }) === 0);
  t.ok('rain response 0.5 thins it by half', near(weatherFactor(rain(0.7), { rainResponse: 0.5 }), 0.5));
  let monotone = true;
  let last = 2;
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const f = weatherFactor(rain(p), { rainResponse: 0.8 });
    if (f > last + 1e-12) monotone = false;
    last = f;
  }
  t.ok('more rain never brings more of them back', monotone);
  t.ok(
    'snow answers to its OWN response: a snow-proof, rain-shy effect is possible',
    weatherFactor(snowing, { rainResponse: 1, snowResponse: 0 }) === 1 &&
      weatherFactor(snowing, { rainResponse: 0, snowResponse: 1 }) === 0
  );

  const breeze = (w) => skyFeel(sky({ wind: { speed01: w } }));
  t.ok(
    'wind below the threshold does nothing, at any response',
    weatherFactor(breeze(0.3), { windThreshold: 0.4, windResponse: 1 }) === 1
  );
  t.ok(
    'wind at a full gale clears an effect with response 1',
    weatherFactor(breeze(1), { windThreshold: 0.4, windResponse: 1 }) === 0
  );
  t.ok(
    'between the two it is a smooth ramp (halfway past the threshold, half gone)',
    near(weatherFactor(breeze(0.7), { windThreshold: 0.4, windResponse: 1 }), 0.5)
  );
  t.ok(
    'a threshold of 1 (never) cannot divide by zero',
    Number.isFinite(weatherFactor(breeze(1), { windThreshold: 1, windResponse: 1 }))
  );

  const chill = (temp) => skyFeel(sky({ weather: { temperature01: temp } }));
  t.ok(
    'no cold response above the threshold temperature',
    weatherFactor(chill(0.4), { coldBelow: 0.3, coldResponse: 1 }) === 1
  );
  t.ok(
    'a freeze clears an effect that minds the cold completely',
    weatherFactor(chill(0), { coldBelow: 0.3, coldResponse: 1 }) === 0
  );
  t.ok(
    'partway into the cold is partway gone',
    near(weatherFactor(chill(0.1), { coldBelow: 0.3, coldResponse: 1 }), 1 - (0.3 - 0.1) / 0.3)
  );
  t.ok('a coldBelow of 0 means "never cold"', weatherFactor(chill(0), { coldBelow: 0, coldResponse: 1 }) === 1);

  t.ok(
    'causes multiply: rain and wind together thin more than either alone',
    (() => {
      const both = skyFeel(sky({ weather: { precip01: 0.35, precipKind: 'rain' }, wind: { speed01: 0.7 } }));
      const p = { rainResponse: 1, windThreshold: 0.4, windResponse: 1 };
      return (
        near(weatherFactor(both, p), 0.5 * 0.5) &&
        weatherFactor(both, p) < weatherFactor(both, { ...p, windResponse: 0 })
      );
    })()
  );
  t.ok(
    'the floor is the brave few: V2 kept a tenth out in a gale and a downpour',
    near(weatherFactor(storm, { rainResponse: 1, windResponse: 1, windThreshold: 0, weatherFloor: 0.1 }), 0.1)
  );
  t.ok(
    'garbage params read as indifferent, never NaN',
    Number.isFinite(weatherFactor(storm, { rainResponse: 'lots', windThreshold: NaN, weatherFloor: undefined })) &&
      weatherFactor(storm, { rainResponse: 'lots' }) === 1
  );

  // ---- how the ones that stay behave ----------------------------------------------------------------
  t.ok(
    'calm air drives nothing: no push, no agitation, no shelter, full tempo',
    (() => {
      const d = weatherDrive(calm, {
        windDrift: 200,
        windAgitation: 2,
        rainShelter: 1,
        coldSlowdown: 1,
        coldBelow: 0.3,
      });
      return d.windPush[0] === 0 && d.windPush[1] === 0 && d.agitation === 1 && d.shelter === 0 && d.tempo === 1;
    })()
  );
  t.ok(
    'the calm drive constant says the same',
    CALM_DRIVE.agitation === 1 && CALM_DRIVE.tempo === 1 && CALM_DRIVE.shelter === 0
  );

  const gale = (deg) => skyFeel(sky({ wind: { speed01: 1, directionDeg: deg } }));
  const east = weatherDrive(gale(90), { windDrift: 100 });
  const north = weatherDrive(gale(0), { windDrift: 100 });
  t.ok(
    'wind blowing TOWARD the east carries a fly +x; toward the north, −y (the map’s y runs down)',
    near(east.windPush[0], 100, 1e-6) &&
      Math.abs(east.windPush[1]) < 1e-6 &&
      Math.abs(north.windPush[0]) < 1e-6 &&
      near(north.windPush[1], -100, 1e-6)
  );
  t.ok(
    'the push scales with the wind (half a gale, half the drift) and with the author’s drift',
    near(
      weatherDrive(skyFeel(sky({ wind: { speed01: 0.5, directionDeg: 90 } })), { windDrift: 100 }).windPush[0],
      50,
      1e-6
    ) && weatherDrive(gale(90), { windDrift: 0 }).windPush[0] === 0
  );
  t.ok(
    'wind agitation raises a flier’s violence with the wind: 1 + agitation × wind',
    near(weatherDrive(gale(0), { windAgitation: 2 }).agitation, 3)
  );
  t.ok(
    'rain agitation is a maggot’s: it writhes harder in the wet',
    near(weatherDrive(rain(0.7), { rainAgitation: 1.5 }).agitation, 2.5) &&
      weatherDrive(rain(0.7), { windAgitation: 3 }).agitation === 1
  );
  t.ok(
    'shelter follows the heavier of rain and snow, scaled by the response',
    near(weatherDrive(rain(0.35), { rainShelter: 1 }).shelter, 0.5) &&
      near(weatherDrive(snowing, { rainShelter: 0.4 }).shelter, 0.4) &&
      weatherDrive(rain(0.7), { rainShelter: 0 }).shelter === 0
  );
  t.ok(
    'cold slows the pace, and never to a standstill',
    near(weatherDrive(chill(0.15), { coldBelow: 0.3, coldSlowdown: 1 }).tempo, 0.5) &&
      weatherDrive(chill(0), { coldBelow: 0.3, coldSlowdown: 1 }).tempo >= 0.15
  );

  // ---- the lists the schemas are held to ------------------------------------------------------------
  t.ok(
    'every param the functions read is named in the lists (so a schema test can find a dead control)',
    [
      'rainResponse',
      'snowResponse',
      'windThreshold',
      'windResponse',
      'coldBelow',
      'coldResponse',
      'weatherFloor',
    ].every((k) => WEATHER_FACTOR_PARAMS.includes(k)) &&
      ['windDrift', 'windAgitation', 'rainAgitation', 'rainShelter', 'coldSlowdown'].every((k) =>
        WEATHER_DRIVE_PARAMS.includes(k)
      )
  );
}
