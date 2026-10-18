/**
 * param-control.js's pure half: the compass arithmetic. The widgets
 * themselves are DOM and browser-verified live (no DOM mock — CONVENTIONS.md
 * §4); what lives here is the arithmetic that decides which direction a
 * bearing IS and whether a click lands on it. Author's ask: *"a compass
 * control so that the user can easily select 'south'"* — "easily" is the
 * magnet, and a magnet with an off-by-one in its table renames every
 * direction silently.
 *
 * Moved verbatim from diag/__tests__/effect-controls.test.mjs at U0
 * (docs/holy/UI-Testament.md §9) alongside the widgets themselves.
 */
import { COMPASS_POINTS, COMPASS_SNAP_DEG, wrapDeg, nearestCompassPoint, fillFraction } from '../param-control.js';

export function run(t) {
  const { ok } = t;

  ok('there are eight points, in bearing order from north', COMPASS_POINTS.length === 8);
  ok(
    '...and the index formula the magnet uses agrees with the table at every one',
    COMPASS_POINTS.every((p, i) => nearestCompassPoint(p.deg).label === p.label && p.deg === i * 45)
  );
  ok(
    'north, east, south and west are where a map reader expects them',
    [
      ['N', 0],
      ['E', 90],
      ['S', 180],
      ['W', 270],
    ].every(([label, deg]) => COMPASS_POINTS.some((p) => p.label === label && p.deg === deg))
  );

  ok('wrapDeg puts 370 at 10', wrapDeg(370) === 10);
  ok('wrapDeg puts −5 at 355, not at −5 (JS `%` keeps the left sign)', wrapDeg(-5) === 355);
  ok('wrapDeg(360) is 0', wrapDeg(360) === 0);
  ok('a non-finite bearing reads as north rather than as NaN', wrapDeg(undefined) === 0);

  // THE SHORT WAY ROUND. At 359 the nearest point is north, ONE degree away —
  // not 359. Getting this wrong disables the magnet in exactly one of the
  // eight sectors, which is the kind of bug that gets reported as "it snaps
  // everywhere except north".
  const almostNorth = nearestCompassPoint(359);
  ok('359° reads as N', almostNorth.label === 'N');
  ok('...and is ONE degree away, measured the short way round the circle', almostNorth.delta === 1);
  ok('...so the magnet catches it', almostNorth.snap === true);

  const nearSouth = nearestCompassPoint(180 - COMPASS_SNAP_DEG + 1);
  ok('a click just inside the magnet of south snaps to south', nearSouth.snap === true && nearSouth.deg === 180);
  const offSouth = nearestCompassPoint(180 - COMPASS_SNAP_DEG - 1);
  ok('a click just outside it does NOT snap — in-between headings stay reachable', offSouth.snap === false);

  // A magnet at or past half a sector would swallow the whole circle and make
  // every heading one of eight. The dial is a free control with eight sticky
  // spots, not an eight-way switch.
  ok(
    'the magnet is well under half a sector, so most of the dial stays free',
    COMPASS_SNAP_DEG > 0 && COMPASS_SNAP_DEG < 22.5
  );

  let everyBearingNamed = true;
  for (let d = 0; d < 360; d += 1) {
    const p = nearestCompassPoint(d);
    if (!p.label || p.delta > 22.5 || p.delta < 0) everyBearingNamed = false;
  }
  ok('every bearing on the circle names a point at most half a sector away', everyBearingNamed);

  // ---- slider fill (the filled part of the track in the Studio) -------------
  ok('fill is 0 at the minimum, 1 at the maximum', fillFraction(0, 0, 1) === 0 && fillFraction(1, 0, 1) === 1);
  ok('fill is proportional in between', fillFraction(0.25, 0, 1) === 0.25 && fillFraction(50, 0, 200) === 0.25);
  ok('fill honours a non-zero minimum', fillFraction(5, 4, 64) === 0.0167 && fillFraction(34, 4, 64) === 0.5);
  ok(
    'fill is clamped: a value outside the range never draws past either end',
    fillFraction(-3, 0, 1) === 0 && fillFraction(9, 0, 1) === 1
  );
  ok('fill accepts the strings an <input> hands back', fillFraction('0.5', '0', '1') === 0.5);
  ok(
    'a degenerate or non-numeric range is 0, never NaN (which would poison the CSS calc())',
    fillFraction(1, 1, 1) === 0 &&
      fillFraction(1, 2, 1) === 0 &&
      fillFraction('x', 0, 1) === 0 &&
      fillFraction(1, 0, undefined) === 0
  );
}
