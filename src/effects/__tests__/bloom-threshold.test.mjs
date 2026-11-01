/**
 * bloom-threshold.test.mjs — the bloom's DAYLIGHT FLOOR (2026-11-01). Measured on Docklands'
 * south docks at noon: a sunlit cobble alone reads ~0.65 in scene.lit and the 0.51 threshold
 * bloomed the whole exterior (+1.5 on top of it). The floor raises the threshold to
 * `dayThreshold` × sunlit white in daylight and leaves the night threshold alone.
 */
import { bloomEffectiveThreshold, BLOOM_PARAMS } from '../bloom.js';

export function run(t) {
  const noon = [0.93, 0.93, 0.93];
  const night = [0.05, 0.05, 0.07];
  const at = (th, d, bg) => bloomEffectiveThreshold(th, d, bg);
  t.ok('at night the authored threshold rules', at(0.51, 1.1, night) === 0.51);
  t.ok('at noon sunlit ground (0.65) sits below the floor', at(0.51, 1.1, noon) > 0.65 * 1.3);
  t.ok('at noon a hot lamp core (1.5) still glows', at(0.51, 1.1, noon) < 1.5);
  t.ok('dayThreshold 0 turns the floor off', at(0.51, 0, noon) === 0.51);
  t.ok('a high authored threshold is never lowered', at(2, 1.1, noon) === 2);
  t.ok('no ambient yet = the authored threshold', at(0.51, 1.1, null) === 0.51);
  t.ok('junk threshold falls back to 1', at(Number.NaN, 0, noon) === 1);
  t.ok('the param ships on', BLOOM_PARAMS.dayThreshold.default > 0);
}
