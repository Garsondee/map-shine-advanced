/**
 * Activity is a pure function of the env snapshot. These tests drive it with REAL
 * snapshots from `world/environment.js` (the same builder the frame loop uses),
 * so the thresholds are proven against the actual sun curve — not against numbers
 * a test author typed in and believed.
 */
import { buildEnvSnapshot } from '../../../world/environment.js';
import {
  flyActivity,
  fireflyActivity,
  weatherCalm,
  fireflyWeather,
  approach,
  activeSlotCount,
} from '../critter-activity.js';

const at = (todHour, weather = {}, wind = {}) =>
  buildEnvSnapshot({ time: { frame: 1, tMs: 1000, dtSec: 0.016 }, todHour, weather, wind });

export function run(t) {
  // ---- weather term is V2's, blended ------------------------------------------------------------
  t.ok('calm weather = 1', weatherCalm(at(12), 1) === 1);
  t.ok(
    'V2 formula: precip 1 + wind 1 → max(0.1, 1−0.8) = 0.2',
    Math.abs(weatherCalm(at(12, { precip01: 1 }, { speed01: 1 }), 1) - 0.2) < 1e-9
  );
  t.ok('V2 floors at 0.1', weatherCalm({ weather: { precip01: 1 }, wind: { speed01: 1 } }, 1) >= 0.1);
  t.ok('response 0 ignores weather entirely', weatherCalm(at(12, { precip01: 1 }, { speed01: 1 }), 0) === 1);
  t.ok('response 0.5 is halfway', Math.abs(weatherCalm(at(12, { precip01: 1 }, { speed01: 1 }), 0.5) - 0.6) < 1e-9);

  // ---- flies: diurnal ---------------------------------------------------------------------------
  t.ok('flies at noon: fully active', flyActivity(at(12)) === 1);
  t.ok('flies at midnight: the night fraction only', Math.abs(flyActivity(at(0), { nightActivity: 0.1 }) - 0.1) < 1e-9);
  t.ok('nightActivity 0 puts flies fully to bed', flyActivity(at(0), { nightActivity: 0 }) === 0);
  t.ok('nightActivity 1 means they never sleep', flyActivity(at(0), { nightActivity: 1 }) === 1);
  let prev = -1;
  let monotone = true;
  for (let h = 4; h <= 9; h += 0.25) {
    const a = flyActivity(at(h), { nightActivity: 0 });
    if (a < prev - 1e-9) monotone = false;
    prev = a;
  }
  t.ok('flies wake monotonically through the morning', monotone);
  t.ok('rain thins the swarm', flyActivity(at(12, { precip01: 1 })) < 0.6);
  t.ok('no snapshot yet reads as an ordinary day', flyActivity(null) === 1);

  // ---- fireflies: a window in sun elevation -----------------------------------------------------
  t.ok('fireflies at noon: none', fireflyActivity(at(12)) === 0);
  t.ok('fireflies at 15:00: none', fireflyActivity(at(15)) === 0);
  const dusk = [];
  for (let h = 16.5; h <= 20.5; h += 0.1) dusk.push({ h, a: fireflyActivity(at(h)) });
  const peak = dusk.reduce((m, d) => (d.a > m.a ? d : m), dusk[0]);
  t.ok(
    `they peak at full strength in the blue hour (peak ${peak.a.toFixed(2)} at ${peak.h.toFixed(1)}h)`,
    peak.a > 0.999
  );
  t.ok('the peak lands in the evening twilight, not at noon or midnight', peak.h > 17.8 && peak.h < 19.2);
  const up = dusk.filter((d) => d.h <= peak.h);
  t.ok(
    'they ramp UP monotonically toward the peak',
    up.every((d, i) => i === 0 || d.a >= up[i - 1].a - 1e-9)
  );
  const down = dusk.filter((d) => d.h >= peak.h);
  t.ok(
    '…and fade DOWN monotonically after it',
    down.every((d, i) => i === 0 || d.a <= down[i - 1].a + 1e-9)
  );
  t.ok('deep night leaves only the residual', Math.abs(fireflyActivity(at(23), { nightResidual: 0.2 }) - 0.2) < 1e-9);
  t.ok('nightResidual 0 means none after the fade', fireflyActivity(at(23), { nightResidual: 0 }) === 0);
  t.ok('the sky window is real: at 18:30 they are out', fireflyActivity(at(18.5)) > 0.9);

  // dusk vs dawn
  t.ok('dawn is the mirror: 05:30 they are out', fireflyActivity(at(5.5)) > 0.9);
  t.ok('dusk disabled hides the evening', fireflyActivity(at(18.5), { dusk: false }) === 0);
  t.ok('…but not the morning', fireflyActivity(at(5.5), { dusk: false }) > 0.9);
  t.ok('dawn disabled hides the morning', fireflyActivity(at(5.5), { dawn: false }) === 0);
  t.ok('…but not the evening', fireflyActivity(at(18.5), { dawn: false }) > 0.9);

  // thresholds are the GM's
  t.ok(
    'a lower appear threshold delays the hatch',
    fireflyActivity(at(17.8), { appearBelowDeg: 4 }) > fireflyActivity(at(17.8), { appearBelowDeg: -2 })
  );
  t.ok('a misconfigured fadeBy above full does not invert the curve', fireflyActivity(at(18.5), { fadeByDeg: 0 }) >= 0);

  // weather
  t.ok('rain grounds fireflies completely', fireflyActivity(at(18.5, { precip01: 1 })) === 0);
  t.ok(
    'weatherResponse 0 lets them fly in the rain',
    fireflyActivity(at(18.5, { precip01: 1 }), { weatherResponse: 0 }) > 0.9
  );
  t.ok(
    'wind thins but does not erase them',
    fireflyActivity(at(18.5, {}, { speed01: 1 })) > 0.3 && fireflyWeather(at(18.5, {}, { speed01: 1 }), 1) < 0.5
  );

  // alwaysActive: for a GM without a day clock
  t.ok('alwaysActive ignores the sky', fireflyActivity(at(12), { alwaysActive: true }) === 1);
  t.ok('…but still respects the rain', fireflyActivity(at(12, { precip01: 1 }), { alwaysActive: true }) === 0);
  t.ok('no env at all → none (never guess a hatch)', fireflyActivity(null) === 0);

  // ---- smoothing --------------------------------------------------------------------------------
  t.ok('approach never overshoots', approach(0, 1, 100, 1) <= 1);
  t.ok('approach with dt 0 stays put', approach(0.3, 1, 0, 1) === 0.3);
  let one = 0;
  one = approach(one, 1, 1, 2);
  let ten = 0;
  for (let i = 0; i < 10; i++) ten = approach(ten, 1, 0.1, 2);
  t.ok('approach is framerate independent (1×1s ≈ 10×0.1s)', Math.abs(one - ten) < 1e-9);
  t.ok('one time constant covers ~63%', Math.abs(approach(0, 1, 2, 2) - (1 - Math.exp(-1))) < 1e-9);

  // ---- slot count -------------------------------------------------------------------------------
  t.ok('activeSlotCount scales the total', activeSlotCount(0.5, 100) === 50);
  t.ok(
    'activeSlotCount keeps the fractional part for the per-slot fade',
    Math.abs(activeSlotCount(0.255, 100) - 25.5) < 1e-9
  );
  t.ok('activeSlotCount clamps', activeSlotCount(7, 10) === 10 && activeSlotCount(-1, 10) === 0);
}
