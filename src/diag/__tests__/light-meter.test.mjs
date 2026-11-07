/**
 * Node verification for diag/light-meter.js (mmp-dpw.10).
 */
import { LIGHT_METER_BANDS, illumToEv, bandIndexForEv, lightMeterStats, falseColourPixels } from '../light-meter.js';

/** Grid helper: cells given as [lit, illum] pairs. */
function grid(cells) {
  const px = new Float32Array(cells.length * 4);
  cells.forEach(([lit, ill], i) => {
    px[i * 4] = lit;
    px[i * 4 + 1] = ill;
  });
  return px;
}

export function run(t) {
  const { ok } = t;
  ok('EV of illum 1 is 0', illumToEv(1) === 0);
  ok('EV of illum 0.5 is -1', illumToEv(0.5) === -1);
  ok('EV is floored, never -Infinity', Number.isFinite(illumToEv(0)));
  ok('band: 0 EV is "bright" (0..+1)', LIGHT_METER_BANDS[bandIndexForEv(0)].id === 'bright');
  ok('band: -0.5 EV is "mid"', LIGHT_METER_BANDS[bandIndexForEv(-0.5)].id === 'mid');
  ok('band: -10 EV is "crushed"', LIGHT_METER_BANDS[bandIndexForEv(-10)].id === 'crushed');
  ok('band: +5 EV is "blown"', LIGHT_METER_BANDS[bandIndexForEv(5)].id === 'blown');
  ok(
    'bands are in ascending order',
    LIGHT_METER_BANDS.every((b, i) => i === 0 || b.max > LIGHT_METER_BANDS[i - 1].max)
  );

  // 4 cells in the map + 1 outside (0,0).
  const s = lightMeterStats(
    grid([
      [0.5, 0.5],
      [0.9, 1.0],
      [1.2, 2.0],
      [0.001, 0.001],
      [0, 0],
    ]),
    5,
    1
  );
  ok('stats: outside-map cells are left out', s.cells === 4);
  ok('stats: per-cell EV null outside the map', s.perCellEv[4] === null);
  ok('stats: over-white share counts lit >= 1', s.overWhiteShare === 0.25);
  ok('stats: crushed share counts the near-black cell', s.crushedShare === 0.25);
  ok('stats: band shares sum to 1', Math.abs(s.bands.reduce((a, b) => a + b.share, 0) - 1) < 1e-9);
  ok('stats: median EV is one of the cells (nearest rank)', [-1, 0, 1].includes(s.evMedian));

  const empty = lightMeterStats(new Float32Array(8), 2, 1);
  ok('stats: empty grid has no cells and null medians', empty.cells === 0 && empty.evMedian === null);

  const fc = falseColourPixels([0, null], 200);
  ok('false colour: in-map cell painted with alpha', fc[3] === 200);
  ok('false colour: outside cell transparent', fc[7] === 0);
}
