/**
 * Activity is a pure function of the env snapshot. These tests drive it with REAL
 * snapshots from `world/environment.js` (the same builder the frame loop uses),
 * so the thresholds are proven against the actual sun curve — not against numbers
 * a test author typed in and believed.
 */
import { buildEnvSnapshot } from '../../../world/environment.js';
import {
  flyActivity,
  maggotActivity,
  fireflyActivity,
  twilightEdges,
  approach,
  activeSlotCount,
} from '../critter-activity.js';
import { skyFeel, weatherFactor } from '../critter-weather.js';

const at = (todHour, weather = {}, wind = {}) =>
  buildEnvSnapshot({ time: { frame: 1, tMs: 1000, dtSec: 0.016 }, todHour, weather, wind });

export function run(t) {
  // ---- V2's weather rule is one setting of the new weather model ------------------------------------
  // V2: `max(0.1, 1 − (precip·0.5 + wind·0.3))`. The model is richer (rain, snow, wind above a threshold
  // and cold each have a response of their own) and V2's rule is reproduced by a rain response of 0.5 / 0.7
  // (V2's precip term saturated at 1; ours at 0.7), a wind response of 0.3 from a threshold of 0, and a
  // floor of 0.1. The numbers below are the sky's own: real snapshots.
  const v2 = { rainResponse: 0.35, windThreshold: 0, windResponse: 0.3, weatherFloor: 0.1 };
  t.ok('calm weather = 1', weatherFactor(skyFeel(at(12)), v2) === 1);
  t.ok(
    'a gale and a downpour hit V2’s floor of a tenth',
    Math.abs(
      weatherFactor(skyFeel(at(12, { precip01: 1, precipKind: 'rain' }, { speed01: 1 })), {
        ...v2,
        rainResponse: 1,
        windResponse: 1,
      }) - 0.1
    ) < 1e-9
  );

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
  t.ok(
    'rain thins the swarm, by the effect’s own rain response',
    flyActivity(at(12, { precip01: 1, precipKind: 'rain' }), { rainResponse: 1 }) === 0 &&
      flyActivity(at(12, { precip01: 1, precipKind: 'rain' }), { rainResponse: 0.5 }) === 0.5 &&
      flyActivity(at(12, { precip01: 1, precipKind: 'rain' }), { rainResponse: 0 }) === 1
  );
  t.ok(
    'snow thins it by the snow response, and a snow-proof effect ignores it',
    flyActivity(at(12, { precip01: 1, precipKind: 'snow' }), { snowResponse: 1 }) === 0 &&
      flyActivity(at(12, { precip01: 1, precipKind: 'snow' }), { rainResponse: 1 }) === 1
  );
  t.ok(
    'a gale clears a wind-shy swarm; a breeze below the threshold does not',
    flyActivity(at(12, {}, { speed01: 1 }), { windThreshold: 0.4, windResponse: 1 }) === 0 &&
      flyActivity(at(12, {}, { speed01: 0.3 }), { windThreshold: 0.4, windResponse: 1 }) === 1
  );
  t.ok(
    'maggots care about weather only: noon, midnight and a calm sky are all the same to them',
    maggotActivity(at(12)) === 1 &&
      maggotActivity(at(0)) === 1 &&
      maggotActivity(at(12, { precip01: 1, precipKind: 'rain' }), { rainResponse: 1 }) === 0 &&
      maggotActivity(at(12, { precip01: 1, precipKind: 'rain' }), { rainResponse: 0.3 }) > 0.6
  );
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

  // The three edge sliders have overlapping ranges, so a GM can drag them into any order. The window must
  // mean the same thing however they are left: dark at noon, a plateau in the blue hour, the residual at night.
  const sunAt = (deg, rising = false) => ({ sun: { elevationDeg: deg, rising }, weather: {}, wind: {} });
  const sweep = (params) => {
    const out = [];
    for (let deg = 60; deg >= -70; deg -= 0.25) out.push({ deg, a: fireflyActivity(sunAt(deg), params) });
    return out;
  };
  const dragged = [
    ['appear below full', { appearBelowDeg: -8, fullBelowDeg: 5, fadeByDeg: -20 }],
    ['fade above full', { appearBelowDeg: 4, fullBelowDeg: -6, fadeByDeg: -2 }],
    ['all three equal', { appearBelowDeg: 0, fullBelowDeg: 0, fadeByDeg: 0 }],
    ['appear equals full', { appearBelowDeg: -3, fullBelowDeg: -3, fadeByDeg: -20 }],
    ['the ranges’ far corner', { appearBelowDeg: -10, fullBelowDeg: 10, fadeByDeg: 0 }],
    ['the ranges’ other corner', { appearBelowDeg: 30, fullBelowDeg: -30, fadeByDeg: -60 }],
    ['garbage', { appearBelowDeg: NaN, fullBelowDeg: 'x', fadeByDeg: undefined }],
  ];
  for (const [name, params] of dragged) {
    const e = twilightEdges(params.appearBelowDeg, params.fullBelowDeg, params.fadeByDeg);
    const curve = sweep({ ...params, nightResidual: 0.2 });
    t.ok(
      `${name}: the edges come out in order (appear ${e.appear} > full ${e.full} > fade ${e.low})`,
      e.appear > e.full && e.full > e.low
    );
    t.ok(
      `${name}: every value is a number in 0..1`,
      curve.every((c) => Number.isFinite(c.a) && c.a >= 0 && c.a <= 1)
    );
    t.ok(
      `${name}: no firefly while the sun is above the first edge (${e.appear}°) — noon is never full`,
      curve.filter((c) => c.deg >= e.appear).every((c) => c.a === 0)
    );
    t.ok(
      `${name}: deep night is the residual, and nothing else`,
      curve.filter((c) => c.deg <= e.low).every((c) => Math.abs(c.a - 0.2) < 1e-9)
    );
    // as the sun sinks: up to the plateau, level, then down to the residual — one hump, never a second
    const rises = curve.map((c, i) => (i === 0 ? 0 : Math.sign(c.a - curve[i - 1].a)));
    const firstFall = rises.findIndex((r) => r < 0);
    t.ok(
      `${name}: one hump — once it starts to fall it never rises again`,
      firstFall < 0 || rises.slice(firstFall).every((r) => r <= 0)
    );
    t.ok(`${name}: the plateau reaches full strength`, Math.max(...curve.map((c) => c.a)) > 0.999);
  }
  // the two settings the review measured, by name
  t.ok(
    'appear −8 / full 5: noon used to be a full colony and midnight none — now noon is empty',
    fireflyActivity(sunAt(40), { appearBelowDeg: -8, fullBelowDeg: 5, fadeByDeg: -20 }) === 0 &&
      fireflyActivity(sunAt(-13), { appearBelowDeg: -8, fullBelowDeg: 5, fadeByDeg: -20, nightResidual: 0 }) > 0.9
  );
  t.ok(
    'fade −2 / full −6: still full at the end of the blue hour, no longer the reverse',
    fireflyActivity(sunAt(-6.2), { appearBelowDeg: 4, fullBelowDeg: -6, fadeByDeg: -2 }) > 0.9
  );
  const ordered = twilightEdges(4, -6, -20);
  t.ok(
    'edges already in order are left exactly as the GM set them',
    ordered.appear === 4 && ordered.full === -6 && ordered.low === -20 && ordered.mid === -13
  );

  // weather: each cause has its own response, and the twilight window multiplies with it
  const shy = { rainResponse: 1, snowResponse: 1, windThreshold: 0.3, windResponse: 0.7 };
  t.ok(
    'rain clears fireflies from the air completely',
    fireflyActivity(at(18.5, { precip01: 1, precipKind: 'rain' }), shy) === 0
  );
  t.ok(
    'a rain response of 0 lets them fly in the rain',
    fireflyActivity(at(18.5, { precip01: 1, precipKind: 'rain' }), { ...shy, rainResponse: 0 }) > 0.9
  );
  t.ok(
    'snow clears them by its own response',
    fireflyActivity(at(18.5, { precip01: 1, precipKind: 'snow' }), shy) === 0 &&
      fireflyActivity(at(18.5, { precip01: 1, precipKind: 'snow' }), { ...shy, snowResponse: 0 }) > 0.9
  );
  t.ok(
    'wind thins but does not erase them (a response of 0.7 leaves 0.3 in a full gale)',
    Math.abs(fireflyActivity(at(18.5, {}, { speed01: 1 }), shy) - 0.3) < 0.05
  );
  t.ok(
    'a cold snap clears a cold-shy colony',
    fireflyActivity(at(18.5, { temperature01: 0 }), { coldBelow: 0.3, coldResponse: 1 }) === 0 &&
      fireflyActivity(at(18.5, { temperature01: 0.6 }), { coldBelow: 0.3, coldResponse: 1 }) > 0.9
  );

  // alwaysActive: for a GM without a day clock
  t.ok('alwaysActive ignores the sky', fireflyActivity(at(12), { alwaysActive: true }) === 1);
  t.ok(
    '…but still respects the rain',
    fireflyActivity(at(12, { precip01: 1, precipKind: 'rain' }), { alwaysActive: true, rainResponse: 1 }) === 0
  );
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
